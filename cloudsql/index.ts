import * as pulumi from "@pulumi/pulumi";
import {
  ComponentResource,
  ComponentResourceOptions,
  Output,
} from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as classicsql from "@pulumi/gcp/sql";

interface CloudSqlArgs {
  name: string;
  projectId: Output<string>;
}

const PULUMI_CONFIG = new pulumi.Config();

export default class CloudSqlComponent extends ComponentResource {
  public readonly password: Output<string>;
  public readonly instance: classicsql.DatabaseInstance;
  public readonly user: classicsql.User;

  constructor(
    { name, projectId }: CloudSqlArgs,
    opts: ComponentResourceOptions = {}
  ) {
    super("CloudSqlComponent", name, undefined, opts);
    const dbPassword = new random.RandomPassword(
      `${name}/password`,
      {
        length: 30,
        special: false,
      },
      { parent: this }
    );

    this.password = dbPassword.result;
    this.instance = new classicsql.DatabaseInstance(
      "db",
      {
        databaseVersion: "POSTGRES_14",
        region: "us-west1",
        deletionProtection: false,
        settings: {
          tier: "db-custom-1-3840",
          availabilityType: "ZONAL",
          diskSize: 10,
          diskType: "PD_SSD",
          ipConfiguration: {
            ipv4Enabled: false,
            privateNetwork: pulumi.interpolate`projects/${projectId}/global/networks/${PULUMI_CONFIG.requireSecret(
              "vpc-id"
            )}`,
            requireSsl: true,
          },
          diskAutoresize: true,
          diskAutoresizeLimit: 50,
        },
        project: projectId,
      },
      { parent: this }
    );

    this.user = new classicsql.User(
      `${name}/user`,
      {
        name,
        instance: this.instance.name,
        password: dbPassword.result,
        deletionPolicy: "ABANDON",
        project: projectId,
      },
      { parent: this }
    );

    this.registerOutputs({
      password: this.password,
      instance: this.instance,
      user: this.user,
    });
  }
}
