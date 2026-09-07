#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HelloWorldStack } from '../lib/hello-world-stack';

const app = new cdk.App();

const targetEnv = app.node.tryGetContext('env');

const envConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
};

if (!targetEnv || targetEnv === 'dev') {
  new HelloWorldStack(app, 'HelloWorldApp-dev', {
    environment: 'dev',
    env: envConfig,
    description: 'Hello World Reference Mini-App Stack (Development)',
  });
}

if (!targetEnv || targetEnv === 'prod') {
  new HelloWorldStack(app, 'HelloWorldApp-prod', {
    environment: 'prod',
    env: envConfig,
    description: 'Hello World Reference Mini-App Stack (Production)',
  });
}

app.synth();
