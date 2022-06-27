import * as cloudContainer from "@pulumi/google-native/container/v1";
import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { RandomPassword } from "@pulumi/random";
import * as cloudDns from "@pulumi/google-native/dns/v1";
import CloudSqlComponent from "./cloudsql";

const PULUMI_CONFIG = new pulumi.Config();
const NAMESPACE = `${pulumi.getStack()}`;
const GCP_PROJECT_ID = new pulumi.Config("google-native").requireSecret(
  "project"
);

const gkeCluster = pulumi
  .all([GCP_PROJECT_ID, PULUMI_CONFIG.requireSecret("gke-cluster-id")])
  .apply(
    async ([project, clusterId]) =>
      await cloudContainer.getCluster({
        clusterId,
        location: "us-west1",
        project,
      })
  );

function kubeConfigTemplate(
  clusterName: Output<string>,
  endpoint: Output<string>,
  clusterCaCert: Output<string>
): Output<string> {
  return pulumi.interpolate`
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${clusterCaCert}
    server: https://${endpoint}
  name: ${clusterName}
contexts:
- context:
    cluster: ${clusterName}
    user: ${clusterName}
  name: ${clusterName}
current-context: ${clusterName}
kind: Config
preferences: {}
users:
- name: ${clusterName}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
  `;
}

const k8sProvider = new k8s.Provider("gke-provider", {
  kubeconfig: kubeConfigTemplate(
    gkeCluster.name,
    gkeCluster.endpoint,
    gkeCluster.masterAuth.clusterCaCertificate
  ),
});

const db = new CloudSqlComponent({
  name: "blackcandy",
  projectId: GCP_PROJECT_ID,
});

const railsSecret = new RandomPassword("rails-secret", {
  length: 30,
  special: false,
});

function toBase64(payload: string): string {
  return Buffer.from(payload).toString("base64");
}

const secrets = new k8s.core.v1.Secret(
  "db-secrets",
  {
    metadata: {
      name: "blackcandy-db-secrets",
      namespace: NAMESPACE,
    },
    data: {
      SECRET_KEY_BASE: railsSecret.result.apply(toBase64),
      DB_PASSWORD: db.password.apply(toBase64),
      DB_HOST: toBase64("localhost"),
      DB_USER: db.user.name.apply(toBase64),
    },
  },
  { provider: k8sProvider }
);

const deployment = new k8s.apps.v1.Deployment(
  "blackcandy",
  {
    metadata: {
      namespace: NAMESPACE,
      name: "blackcandy",
      labels: {
        app: "blackcandy",
      },
    },
    spec: {
      replicas: 2,
      selector: {
        matchLabels: {
          app: "blackcandy",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "blackcandy",
          },
        },
        spec: {
          serviceAccount: "blackcandy-ksa",
          containers: [
            {
              image: "blackcandy/blackcandy:2.0.1",
              name: "blackcandy",
              envFrom: [
                {
                  secretRef: {
                    name: secrets.metadata.name,
                  },
                },
              ],
              ports: [
                {
                  containerPort: 3000,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              readinessProbe: {
                initialDelaySeconds: 30,
                httpGet: {
                  path: "/session/new",
                  port: 3000,
                  scheme: "HTTP",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/session/new",
                  port: 3000,
                  scheme: "HTTP",
                },
              },
              resources: {
                requests: {
                  cpu: "2",
                  memory: "4Gi",
                },
              },
            },
            {
              name: "cloud-sql-proxy",
              image: "gcr.io/cloudsql-docker/gce-proxy:1.28.1",
              command: [
                "/cloud_sql_proxy",
                pulumi.interpolate`-instances=${db.instance.connectionName}=tcp:5432`,
                "-use_http_health_check",
              ],
              securityContext: {
                runAsNonRoot: true,
              },
              readinessProbe: {
                initialDelaySeconds: 10,
                httpGet: {
                  path: "/readiness",
                  port: 8090,
                  scheme: "HTTP",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/readiness",
                  port: 8090,
                  scheme: "HTTP",
                },
              },
              resources: {
                requests: {
                  memory: "2Gi",
                  cpu: "1",
                },
              },
            },
          ],
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [db.user] }
);

const blackcandyService = new k8s.core.v1.Service(
  "blackcandy-svc",
  {
    metadata: {
      name: "blackcandy-svc",
      namespace: NAMESPACE,
      annotations: {
        "cloud.google.com/neg": JSON.stringify({
          ingress: true,
        }),
      },
    },
    spec: {
      sessionAffinity: "None",
      type: "ClusterIP",
      selector: deployment.spec.template.metadata.labels,
      ports: [
        {
          port: 80,
          protocol: "TCP",
          targetPort: 3000,
        },
      ],
    },
  },
  { provider: k8sProvider }
);

const domain = `${NAMESPACE}.interviews.binti.engineering`;

const ingress = new k8s.networking.v1.Ingress(
  "blackcandy",
  {
    metadata: {
      namespace: NAMESPACE,
      name: "blackcandy",
      annotations: {
        "kubernetes.io/ingress.class": "gce",
      },
    },
    spec: {
      defaultBackend: {
        service: {
          name: blackcandyService.metadata.name,
          port: {
            number: 80,
          },
        },
      },
    },
  },
  { provider: k8sProvider }
);

new cloudDns.ResourceRecordSet(`${NAMESPACE}.interviews.binti.engineering`, {
  managedZone: "interviews-binti-engineering",
  name: `${domain}.`,
  type: "A",
  ttl: 300, // 5 minutes
  rrdatas: ingress.status.loadBalancer.ingress.apply((entries) =>
    entries.map((entry) => entry.ip)
  ),
});
