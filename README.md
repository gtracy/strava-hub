# Strava Hub 🏃‍♂️🚴‍♀️

> An open-source, multi-tenant foundation platform and extensible mini-app ecosystem built on AWS and Strava.

[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![AWS CDK](https://img.shields.io/badge/AWS%20CDK-v2-orange.svg)](https://aws.amazon.com/cdk/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-83%20passed-brightgreen.svg)]()

Strava Hub connects to the Strava API, ingests webhooks, securely stores athlete and activity data in a hybrid AWS storage layer (DynamoDB + S3), and broadcasts activity lifecycle events over Amazon EventBridge. Developers can independently build, deploy, and discover mini-apps that consume these activity streams without needing to manage their own webhook infrastructure or OAuth pipelines.

---

## 🌟 Architecture Overview

```
                      +-------------------+
                      |   Strava API &    |
                      |  Webhook Engine   |
                      +---------+---------+
                                |
             Webhook Push /     | OAuth Code Exchange
             Historical Sync    v
                      +---------+---------+
                      |  API Gateway v2   |
                      |   (HTTP API)      |
                      +----+---------+----+
                           |         |
             Enqueues Sync |         | Enqueues 60-day Fetch
                           v         v
                     +-----+---+ +---+-----+
                     |  Sync   | |  Fetch  |
                     |  Queue  | |  Queue  |
                     +-----+---+ +---+-----+
                           |         |
                           v         v
                     +-----+---+ +---+-----+
                     |  Sync   | |  Fetch  |
                     | Worker  | | Worker  |
                     +-----+---+ +---------+
                           |
      +--------------------+--------------------+
      |                    |                    |
      v                    v                    v
+-----------+        +-----------+        +------------+
| DynamoDB  |        |    S3     |        | EventBridge|
| Metadata  |        | Raw JSON  |        | Event Bus  |
+-----------+        +-----------+        +-----+------+
                                                |
                     +--------------------------+--------------------------+
                     |                          |                          |
                     v                          v                          v
             +-------+-------+          +-------+-------+          +-------+-------+
             | Mini-App #1   |          | Mini-App #2   |          | Mini-App #N   |
             | (Hello World) |          | (e.g. AI Coach|          | (e.g. 3D Map) |
             +---------------+          +---------------+          +---------------+
```

### Key Platform Components

1. **Hybrid Data Store**:
   - **Amazon DynamoDB**: Provides single-digit millisecond query performance for athlete tokens and activity summary metadata (`distance`, `movingTime`, `type`, `startDate`, `summaryPolyline`). The `AthleteStartDateIndex` GSI enables instant reverse-chronological pagination.
   - **Amazon S3**: Immutable, encrypted lake storing complete, uncompressed raw Strava activity JSON payloads (including high-resolution sensor streams and high-res route polylines at `athletes/{athleteId}/activities/{activityId}.json`).
2. **KMS Envelope Encryption**:
   - Strava OAuth refresh tokens and access tokens are encrypted at rest using AWS KMS Customer Managed Keys (CMKs) before persisting to DynamoDB.
3. **Decoupled Mini-App Bus**:
   - Every activity creation, update, or deletion is published to a dedicated Amazon EventBridge event bus (`strava-hub-${stage}-bus`) with envelope source `strava.hub.activity`.
   - Mini-apps subscribe via standard EventBridge rules and SQS queues, requiring zero coordination with the core platform.
4. **App Registry & Discovery**:
   - Mini-apps placed under `apps/<app-name>` define a `manifest.json` and `README.md`.
   - The core API dynamically advertises registered mini-apps, their capabilities, event subscriptions, and full documentation to signed-in users.
5. **Modern Web Dashboard**:
   - React 19 + Vite SPA hosted securely on AWS S3 + CloudFront with Origin Access Control (OAC).
   - Allows athletes to connect via Strava OAuth, view data sync health, trigger historical backfills, preview available mini-apps, read app documentation, or perform full GDPR data wipes.

---

## 📁 Repository Structure

```
strava-hub/
├── apps/                         # Independent Mini-App ecosystem
│   └── hello-world/              # Reference mini-app (cheers new runs/rides)
│       ├── manifest.json         # Capability advertising & event subscriptions
│       ├── README.md             # In-app documentation (rendered in catalog)
│       ├── src/handler.js        # Event consumer Lambda handler
│       ├── infrastructure/       # Independent AWS CDK stack
│       └── __tests__/            # Unit test suite
├── core/
│   ├── frontend/                 # React 19 + Vite Web Application
│   │   ├── src/components/       # UI components (AppCatalog, DocModal, etc.)
│   │   └── dist/                 # Built production bundle
│   ├── infrastructure/           # Core Platform AWS CDK Stacks
│   │   ├── bin/strava-hub.ts     # CDK App entry point (dev & prod)
│   │   ├── lib/core-data-stack.ts# DynamoDB, S3, KMS, EventBridge, SSM parameters
│   │   ├── lib/api-stack.ts      # HTTP API, SQS queues, Lambda functions
│   │   ├── lib/web-stack.ts      # S3 SPA bucket, CloudFront distribution
│   │   └── test/                 # CDK infrastructure unit tests
│   └── src/                      # Core backend services & workers
│       ├── app.js                # API Gateway Lambda router
│       ├── logger.js             # Structured Pino logger
│       ├── repositories/         # DynamoDB & S3 data access layers
│       ├── services/             # Strava API, KMS, EventBridge, SQS, App Registry
│       └── workers/              # SQS worker Lambdas (sync-worker, fetch-worker)
├── env.json.example              # Configuration template for CDK deployments
└── package.json                  # Monorepo scripts & dependencies
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v22.x or higher
- **AWS CLI**: Configured with credentials for your AWS account (`aws configure`)
- **AWS CDK**: Version 2.238+ (`npm install -g aws-cdk`)
- **Strava Developer Account**: Create an application at [strava.com/settings/api](https://www.strava.com/settings/api).
  > **Note on Webhooks**: Strava allows only **one active webhook callback URL per client ID**. Therefore, create separate Strava API applications for your `dev` and `prod` environments.

### 1. Configuration Setup

Copy the example configuration file:

```bash
cp env.json.example env.json
```

Populate `env.json` with your Strava credentials and a secure JWT secret:

```json
{
  "dev": {
    "STRAVA_CLIENT_ID": "12345",
    "STRAVA_CLIENT_SECRET": "your-dev-strava-client-secret",
    "STRAVA_VERIFY_TOKEN": "a-random-secret-verify-token",
    "JWT_SECRET": "a-long-random-string-at-least-32-chars-long",
    "LOG_LEVEL": "debug",
    "AWS_REGION": "us-east-2"
  },
  "prod": {
    "STRAVA_CLIENT_ID": "67890",
    "STRAVA_CLIENT_SECRET": "your-prod-strava-client-secret",
    "STRAVA_VERIFY_TOKEN": "another-random-verify-token",
    "JWT_SECRET": "another-long-random-string-at-least-32-chars",
    "LOG_LEVEL": "info",
    "AWS_REGION": "us-east-2"
  }
}
```

### 2. Install Dependencies & Run Tests

```bash
# Install root dependencies
npm install

# Run all 83 unit tests across core and apps
npm test
```

---

## ☁️ Deployment

### 1. Deploy the Core Platform

The core platform deploys three coordinated CDK stacks (`Data`, `Api`, and `Web`):

```bash
# Deploy to development environment
npm run cdk:deploy:dev

# Or deploy to production environment
npm run cdk:deploy:prod
```

Upon successful deployment, CDK outputs your API Gateway URL and CloudFront Web URL:
- `StravaHubApi-dev.HttpApiUrl`: `https://abcdef123.execute-api.us-east-2.amazonaws.com`
- `StravaHubWeb-dev.FrontendUrlOutput`: `https://d123456abcdef.cloudfront.net`

### 2. Register Your Strava Webhook

Strava requires a one-time verification handshake. Using your API Gateway URL and the verify token from `env.json`:

```bash
# 1. Verify handshake locally / via curl
curl "https://<your-api-id>.execute-api.<region>.amazonaws.com/webhook?hub.mode=subscribe&hub.challenge=test_challenge&hub.verify_token=<your-verify-token>"
# Should return: {"hub.challenge":"test_challenge"}

# 2. Register subscription with Strava API
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id="<your-client-id>" \
  -F client_secret="<your-client-secret>" \
  -F callback_url="https://<your-api-id>.execute-api.<region>.amazonaws.com/webhook" \
  -F verify_token="<your-verify-token>"
```

### 3. Deploy Mini-Apps

Each mini-app in `apps/` can be deployed independently:

```bash
cd apps/hello-world
npm install
npm run cdk:deploy:dev
```

Mini-apps query AWS SSM Parameter Store at deploy-time (e.g. `/strava-hub/dev/event-bus-arn`, `/strava-hub/dev/activities-table-name`) to connect seamlessly to the core platform without hardcoded cross-stack CloudFormation references.

---

## 💻 Local Development (Frontend)

To run the React web dashboard locally:

```bash
cd core/frontend
npm install

# Set your deployed API Gateway endpoint
echo "VITE_API_BASE_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com" > .env.local
echo "VITE_STRAVA_CLIENT_ID=<your-strava-client-id>" >> .env.local

# Start development server
npm run dev
```

Open `http://localhost:5173` in your browser to sign in with Strava and explore the dashboard.

---

## 🛠️ Building a New Mini-App

Strava Hub makes it straightforward to add new experiences. Follow these steps to build an app:

### 1. Create App Directory

Create a folder in `apps/<my-app-name>`:

```bash
mkdir -p apps/my-app/src apps/my-app/infrastructure/lib
```

### 2. Define `manifest.json`

Every mini-app advertises its metadata, UI tags, required permissions, and event subscriptions:

```json
{
  "id": "my-app",
  "name": "My Strava App",
  "version": "1.0.0",
  "description": "Analyzes workout intensity and generates custom summaries.",
  "author": "Your Name",
  "category": "analytics",
  "image": "assets/preview.png",
  "capabilities": [
    "Heart rate zone distribution",
    "Weekly intensity scoring"
  ],
  "eventSubscriptions": [
    "ActivityCreated",
    "ActivityUpdated"
  ],
  "permissions": {
    "readActivities": true,
    "readRawPayloads": true
  }
}
```

### 3. Add `README.md`

Add a markdown guide explaining what the app does and how to configure it. This documentation is automatically fetched by `/api/apps` and rendered interactively inside the web dashboard modal!

### 4. Subscribe to EventBridge

In your app's CDK stack, look up the core EventBus ARN via SSM and route events to an SQS queue:

```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const eventBusArn = ssm.StringParameter.valueForStringParameter(
  this,
  `/strava-hub/${stage}/event-bus-arn`
);
const eventBus = events.EventBus.fromEventBusArn(this, 'ImportedBus', eventBusArn);

const rule = new events.Rule(this, 'ActivityRule', {
  eventBus,
  eventPattern: {
    source: ['strava.hub.activity'],
    detailType: ['ActivityCreated', 'ActivityUpdated'],
  },
});

rule.addTarget(new targets.SqsQueue(myAppQueue));
```

### Event Payload Schema

Events published to EventBridge adhere to the following schema:

```json
{
  "version": "0",
  "source": "strava.hub.activity",
  "detail-type": "ActivityCreated",
  "detail": {
    "athleteId": "12345678",
    "activityId": "987654321",
    "aspectType": "create",
    "name": "Morning Tempo Run",
    "type": "Run",
    "distance": 8500.0,
    "movingTime": 2400,
    "startDate": "2026-09-06T14:30:00Z",
    "summaryPolyline": "g`~eFvnbvOn...",
    "hasRouteMap": true,
    "s3PayloadLocation": "athletes/12345678/activities/987654321.json",
    "timestamp": 1788705000
  }
}
```

---

## 🔒 Security & Privacy (GDPR)

- **Token Security**: Tokens are never stored in plain text. KMS symmetric encryption handles all token persistence.
- **Cascading Athlete Deletion**: When an athlete invokes `DELETE /user` (via the dashboard or API), Strava Hub:
  1. Deauthorizes the athlete token with Strava's OAuth revocation endpoint.
  2. Deletes all athlete activity records and indices from DynamoDB.
  3. Deletes all raw payload files from S3 (`athletes/{athleteId}/*`).
  4. Deletes the athlete record from DynamoDB.
  5. Publishes an `AthleteDeleted` event so mini-apps can clean up their respective databases.

---

## 📜 License

MIT License. See [LICENSE](LICENSE) for details.
