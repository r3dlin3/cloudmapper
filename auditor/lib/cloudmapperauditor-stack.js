/**
 * Deploys the CloudMapper audit app.
 */

const cdk = require('@aws-cdk/core');
const ecs = require('@aws-cdk/aws-ecs');
const ecsPatterns = require('@aws-cdk/aws-ecs-patterns');
const ec2 = require('@aws-cdk/aws-ec2');
const logs = require('@aws-cdk/aws-logs');
const iam = require('@aws-cdk/aws-iam');
const events = require('@aws-cdk/aws-events');
const targets = require('@aws-cdk/aws-events-targets');
const cloudwatch = require('@aws-cdk/aws-cloudwatch');
const cloudwatch_actions = require('@aws-cdk/aws-cloudwatch-actions');
const sns = require('@aws-cdk/aws-sns');
const sns_subscription = require('@aws-cdk/aws-sns-subscriptions');
const lambda = require('@aws-cdk/aws-lambda');

// Import libraries to read a config file
const yaml = require('js-yaml');
const fs = require('fs');

class CloudmapperauditorStack extends cdk.Stack {
  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Load config file
    var config = yaml.safeLoad(fs.readFileSync('./s3_bucket_files/cdk_app.yaml', 'utf8'));

    if (config['s3_bucket'] == 'MYCOMPANY-cloudmapper') {
      console.log("You must configure the CDK app by editing ./s3_bucket_files/cdk_app.yaml");
      process.exit(1);
    }

    // Create VPC to run everything in, but without a NAT gateway.
    // We want to run in a public subnet, but the CDK creates a private subnet
    // by default, which results in the use of a NAT gateway, which costs $30/mo.
    // To avoid that unnecessary charge, we have to create the VPC in a complicated
    // way.
    // This trick was figured out by jeshan in https://github.com/aws/aws-cdk/issues/1305#issuecomment-525474540
    // Normally, the CDK does not allow this because the private subnets have to have
    // a route out, and you can't get rid of the private subnets.
    // So the trick is to remove the routes out.
    // The private subnets remain, but are not usable and have no costs.
    const vpc = new ec2.Vpc(this, 'CloudMapperVpc', {
        maxAzs: 2,
        natGateways: 0
    });

    // Create a condition that will always fail.
    // We will use this in a moment to remove the routes.
    var exclude_condition = new cdk.CfnCondition(this,
      'exclude-default-route-subnet',
      {
        // Checks if true == false, so this always fails
        expression: cdk.Fn.conditionEquals(true, false)
      }
    );

    // For the private subnets, add a CloudFormation condition to the routes
    // to cause them to not be created.
    for (var subnet of vpc.privateSubnets) {
        for (var child of subnet.node.children) {
            if (child.constructor.name==="CfnRoute") {
              child.cfnOptions.condition = exclude_condition
            }
        }
    }

    // Define the ECS task
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'taskDefinition', {});

    taskDefinition.addContainer('cloudmapper-container', {
      image: ecs.ContainerImage.fromAsset('./resources'),
      memoryLimitMiB: 512,
      cpu: 256,
      environment: {
        S3_BUCKET: config['s3_bucket']
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'cloudmapper',
        logRetention: logs.RetentionDays.TWO_WEEKS
      })
    });

    // Grant the ability to assume the IAM role in any account
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:iam::*:role/"+config['iam_role']],
      actions: ['sts:AssumeRole']
    }));

    // Grant the ability to read and write the files from the S3 bucket
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:s3:::"+config['s3_bucket']],
      actions: ['s3:ListBucket']
    }));
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["arn:aws:s3:::"+config['s3_bucket']+"/*"],
      actions: ['s3:GetObject','s3:PutObject', 's3:DeleteObject']
    }));

    // Grant the ability to record the stdout to CloudWatch Logs
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      resources: ["*"],
      actions: ['logs:*']
    }));

    // Grant the ability to record error and success metrics
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      // This IAM privilege has no paths or conditions
      resources: ["*"],
      actions: ['cloudwatch:PutMetricData']
    }));

    // Grant the ability to read from Secrets Manager
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      // This IAM privilege has no paths or conditions
      resources: ["*"],
      actions: ['secretsmanager:GetSecretValue'],
      conditions: {'ForAnyValue:StringLike':{'secretsmanager:SecretId': '*cloudmapper-slack-webhook*'}}
    }));

    // Create rule to trigger this be run every 24 hours
    new events.Rule(this, "scheduled_run", {
      ruleName: "cloudmapper_scheduler",
      // Run at 2am EST (6am UTC) every night
      schedule: events.Schedule.expression("cron(0 6 * * ? *)"),
      description: "Starts the CloudMapper auditing task every night",
      targets: [new targets.EcsTask({
        cluster: cluster,
        taskDefinition: taskDefinition,
        subnetSelection: {subnetType: ec2.SubnetType.PUBLIC}
      })]
    });

    // Create rule to trigger this manually
    new events.Rule(this, "manual_run", {
      ruleName: "cloudmapper_manual_run",
      eventPattern: {source: ['cloudmapper']},
      description: "Allows CloudMapper auditing to be manually started",
      targets: [new targets.EcsTask({
        cluster: cluster,
        taskDefinition: taskDefinition,
        subnetSelection: {subnetType: ec2.SubnetType.PUBLIC}
      })]
    });

    // Create alarm for any errors
    const error_alarm =  new cloudwatch.Alarm(this, "error_alarm", {
      metric: new cloudwatch.Metric({
        namespace: 'cloudmapper',
        metricName: "errors",
        statistic: "Sum"
      }),
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Detect errors",
      alarmName: "cloudmapper_errors"
    });

    // Create SNS for alarms to be sent to
    const sns_topic = new sns.Topic(this, 'cloudmapper_alarm', {
      displayName: 'cloudmapper_alarm'
    });

    // Connect the alarm to the SNS
    error_alarm.addAlarmAction(new cloudwatch_actions.SnsAction(sns_topic));

    // Create Lambda to forward alarms
    const alarm_forwarder = new lambda.Function(this, "alarm_forwarder", {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.Code.asset("resources/alarm_forwarder"),
      handler: "main.handler",
      description: "Forwards alarms from the local SNS to another",
      logRetention: logs.RetentionDays.TWO_WEEKS,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        "ALARM_SNS": config['alarm_sns_arn']
      },
    });

    // Add priv to publish the events so the alarms can be forwarded
    alarm_forwarder.addToRolePolicy(new iam.PolicyStatement({
      resources: [config['alarm_sns_arn']],
      actions: ['sns:Publish']
    }));

    // Connect the SNS to the Lambda
    sns_topic.addSubscription(new sns_subscription.LambdaSubscription(alarm_forwarder));
  }
}

module.exports = { CloudmapperauditorStack }
