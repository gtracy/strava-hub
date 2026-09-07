# Hello World Reference App

Welcome to the **Hello World** reference mini-app for **Strava Hub**!

This mini-app demonstrates the standard architecture and reference design for any new service or experience built on top of the Strava Hub platform.

---

## 🌟 What This App Does

- **EventBridge Event Subscription**: Listens for `ActivityCreated` and `ActivityUpdated` events dispatched to the custom `strava-hub-${env}-bus` EventBridge bus whenever new Strava activities are synced.
- **Reliable SQS Buffering**: Consumes events via an Amazon SQS queue with an automatic Dead Letter Queue (DLQ), ensuring zero lost events during spikes.
- **Shared Data Layer Access**: Reads metadata (including distance, duration, elevation, and polyline route) directly from the multi-tenant DynamoDB and S3 raw storage without ever calling the external Strava API or exhausting rate limits.
- **Automated Logging**: Prints an encouraging cheer and summary for the athlete's completed workout.

---

## 🏗️ Architecture Pattern

```
Platform EventBridge Bus (strava-hub-${env}-bus)
             |
             | Rule: source = "strava.hub.activity", detail-type in ["ActivityCreated", "ActivityUpdated"]
             v
   App SQS Queue (hello-world-${env}-queue)
             |
             v SqsEventSource
   App Consumer Lambda (hello-world-${env}-consumer)
             |
             +---> Read Metadata from shared DynamoDB Table
             +---> Read Raw JSON from shared S3 Bucket
             +---> Execute custom mini-app business logic
```

---

## 🚀 How to Deploy

Each mini-app in `apps/` stands completely on its own with its own AWS CDK configuration.

### Prerequisites
- AWS credentials configured in your terminal with CDK deploy permissions.
- The Core Strava Hub stack deployed (`StravaHubData-${env}` and `StravaHubApi-${env}`).

### Commands
```bash
# Navigate to the app directory
cd apps/hello-world

# Install dependencies
npm install

# Synthesize the CloudFormation template (dev)
npm run cdk:synth:dev

# Deploy to your AWS environment
npm run cdk:deploy:dev
```

---

## 📖 Building Your Own Mini-App

To build a new mini-app based on this reference design:
1. Copy `apps/hello-world` to `apps/<your-app-name>`.
2. Update `manifest.json` with your app's name, description, capabilities, and image.
3. Customize the EventBridge filter in `infrastructure/lib/<your-app>-stack.ts` for the specific activity types (e.g. `Run`, `Ride`) or events your app requires.
4. Implement your custom business logic in `src/handler.js`.
