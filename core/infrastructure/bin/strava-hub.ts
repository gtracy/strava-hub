#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreDataStack } from '../lib/core-data-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

// Target environment from context (e.g. -c env=prod), or synthesize both
const targetEnv = app.node.tryGetContext('env');

const envConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
};

if (!targetEnv || targetEnv === 'dev') {
  const dataDev = new CoreDataStack(app, 'StravaHubData-dev', {
    environment: 'dev',
    env: envConfig,
    description: 'Strava Hub Core Data Stack (Development Environment)',
  });

  const apiDev = new ApiStack(app, 'StravaHubApi-dev', {
    environment: 'dev',
    env: envConfig,
    description: 'Strava Hub API and Ingestion Stack (Development Environment)',
    kmsKey: dataDev.kmsKey,
    athletesTable: dataDev.athletesTable,
    activitiesTable: dataDev.activitiesTable,
    rawBucket: dataDev.rawBucket,
    eventBus: dataDev.eventBus,
  });

  apiDev.addStackDependency(dataDev);
}

if (!targetEnv || targetEnv === 'prod') {
  const dataProd = new CoreDataStack(app, 'StravaHubData-prod', {
    environment: 'prod',
    env: envConfig,
    description: 'Strava Hub Core Data Stack (Production Environment)',
  });

  const apiProd = new ApiStack(app, 'StravaHubApi-prod', {
    environment: 'prod',
    env: envConfig,
    description: 'Strava Hub API and Ingestion Stack (Production Environment)',
    kmsKey: dataProd.kmsKey,
    athletesTable: dataProd.athletesTable,
    activitiesTable: dataProd.activitiesTable,
    rawBucket: dataProd.rawBucket,
    eventBus: dataProd.eventBus,
  });

  apiProd.addStackDependency(dataProd);
}

app.synth();
