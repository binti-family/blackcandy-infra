import * as cloudContainer from "@pulumi/google-native/container/v1";
import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as cloudSql from "@pulumi/google-native/sqladmin/v1beta4";
import * as random from "@pulumi/random";
import { RandomPassword } from "@pulumi/random";
import * as cloudDns from "@pulumi/google-native/dns/v1";

const PULUMI_CONFIG = new pulumi.Config();
const NAMESPACE = `${pulumi.getStack()}-test`;
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

const dbPassword = new random.RandomPassword("db-pw", {
  length: 30,
});

const sql = new cloudSql.Instance("db", {
  databaseVersion: "POSTGRES_14",
  gceZone: "us-west1-c",
  instanceType: "CLOUD_SQL_INSTANCE",
  region: "us-west1",
  rootPassword: dbPassword.result,
  settings: {
    tier: "db-custom-2-7680",
    availabilityType: "ZONAL",
    dataDiskSizeGb: "20",
    dataDiskType: "PD_SSD",
    ipConfiguration: {
      ipv4Enabled: false,
      privateNetwork: pulumi.interpolate`projects/${GCP_PROJECT_ID}/global/networks/${PULUMI_CONFIG.requireSecret(
        "vpc-id"
      )}`,
      requireSsl: true,
    },
    storageAutoResizeLimit: "50",
    userLabels: {
      purpose: "devops-interview",
    },
  },
  project: GCP_PROJECT_ID,
});

const railsSecret = new RandomPassword("rails-secret", {
  length: 30,
});

function toBase64(payload: string): string {
  return Buffer.from(payload).toString("base64");
}

const secrets = new k8s.core.v1.Secret("db-secrets", {
  metadata: {
    name: "blackcandy-db-secrets",
    namespace: NAMESPACE,
  },
  data: {
    SECRET_KEY_BASE: railsSecret.result.apply(toBase64),
    DB_PASSWORD: dbPassword.result.apply(toBase64),
    DB_HOST: toBase64("localhost"),
    DB_USER: toBase64("postgres"),
  },
});

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
                pulumi.interpolate`-instances=${sql.connectionName}=tcp:5432`,
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
  { provider: k8sProvider }
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
const certificate = new k8s.apiextensions.CustomResource("managed-tls-cert", {
  apiVersion: "networking.gke.io/v1",
  kind: "ManagedCertificate",
  metadata: {
    name: "blackcandy-cert",
    namespace: NAMESPACE,
  },
  spec: {
    domains: [domain],
  },
});

const frontendConfig = new k8s.apiextensions.CustomResource(
  "front-end-config",
  {
    apiVersion: "networking.gke.io/v1beta1",
    kind: "FrontendConfig",
    metadata: {
      name: "http-redirect-to-https",
      namespace: NAMESPACE,
    },
    spec: {
      redirectToHttps: {
        enabled: true,
        responseCodeName: "MOVED_PERMANENTLY_DEFAULT",
      },
    },
  }
);

const ingress = new k8s.networking.v1.Ingress(
  "blackcandy",
  {
    metadata: {
      namespace: NAMESPACE,
      name: "blackcandy",
      annotations: {
        "networking.gke.io/managed-certificates": certificate.metadata.name,
        "kubernetes.io/ingress.class": "gce",
        "networking.gke.io/v1beta1.FrontendConfig":
          frontendConfig.metadata.name,
      },
    },
    spec: {
      rules: [
        {
          host: domain,
          http: {
            paths: [
              {
                path: "/*",
                pathType: "ImplementationSpecific",
                backend: {
                  service: {
                    name: blackcandyService.metadata.name,
                    port: {
                      number: 80,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
  { provider: k8sProvider }
);

new cloudDns.ResourceRecordSet(`${NAMESPACE}.interviews.binti.engineering`, {
  managedZone: "interviews-binti-engineering",
  name: `${domain}.`,
  type: "A",
  rrdatas: ingress.status.loadBalancer.ingress.apply((entries) =>
    entries.map((entry) => entry.ip)
  ),
  project: new pulumi.Config().requireSecret("hub-project"),
});
