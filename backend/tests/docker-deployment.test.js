import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

describe('Phase 6 — Step 6: Production Docker & Deployment Readiness Test Suite', () => {

  describe('1. Dockerfiles Validation', () => {
    const dockerfiles = [
      { name: 'backend', path: path.join(rootDir, 'backend/Dockerfile') },
      { name: 'frontend', path: path.join(rootDir, 'frontend/Dockerfile') },
      { name: 'ml-service', path: path.join(rootDir, 'ml-service/Dockerfile') },
      { name: 'genai-service', path: path.join(rootDir, 'genai-service/Dockerfile') },
    ];

    test('1.1 Production Dockerfiles exist for all 4 services', () => {
      for (const { name, path: filePath } of dockerfiles) {
        assert.ok(fs.existsSync(filePath), `Dockerfile for ${name} must exist at ${filePath}`);
      }
    });

    test('1.2 Dockerfiles define appropriate base images, non-watch production commands and exposed ports', () => {
      const backendDf = fs.readFileSync(path.join(rootDir, 'backend/Dockerfile'), 'utf-8');
      assert.ok(backendDf.includes('node:22-alpine') || backendDf.includes('node:22'));
      assert.ok(backendDf.includes('EXPOSE 4000'));
      assert.ok(backendDf.includes('HEALTHCHECK'));
      assert.ok(backendDf.includes('server.js'));
      assert.ok(!backendDf.includes('nodemon'), 'Production Dockerfile must not run nodemon watcher');

      const frontendDf = fs.readFileSync(path.join(rootDir, 'frontend/Dockerfile'), 'utf-8');
      assert.ok(frontendDf.includes('FROM node:22-alpine'));
      assert.ok(frontendDf.includes('EXPOSE 3000'));
      assert.ok(frontendDf.includes('npm run build'));
      assert.ok(!frontendDf.includes('next dev'), 'Production Dockerfile must not run next dev');

      const mlDf = fs.readFileSync(path.join(rootDir, 'ml-service/Dockerfile'), 'utf-8');
      assert.ok(mlDf.includes('python:3.11-slim'));
      assert.ok(mlDf.includes('EXPOSE 8000'));
      assert.ok(mlDf.includes('HEALTHCHECK'));

      const genaiDf = fs.readFileSync(path.join(rootDir, 'genai-service/Dockerfile'), 'utf-8');
      assert.ok(genaiDf.includes('python:3.11-slim'));
      assert.ok(genaiDf.includes('EXPOSE 8001'));
      assert.ok(genaiDf.includes('HEALTHCHECK'));
    });
  });

  describe('2. Docker Compose Configuration & Topology', () => {
    const composePath = path.join(rootDir, 'docker-compose.yml');

    test('2.1 docker-compose.yml exists and defines all 9 required services', () => {
      assert.ok(fs.existsSync(composePath));
      const content = fs.readFileSync(composePath, 'utf-8');

      const requiredServices = [
        'postgres',
        'redis',
        'qdrant',
        'minio',
        'redpanda',
        'ml-service',
        'genai-service',
        'backend',
        'frontend',
      ];

      for (const svc of requiredServices) {
        assert.ok(content.includes(`${svc}:`), `docker-compose.yml must define service '${svc}'`);
      }
    });

    test('2.2 Service-to-service DNS networking is properly configured', () => {
      const content = fs.readFileSync(composePath, 'utf-8');

      assert.ok(content.includes('postgres:5432'), 'Backend must connect to postgres on internal port 5432');
      assert.ok(content.includes('redis:6379'), 'Backend must connect to redis container');
      assert.ok(content.includes('redpanda:9092'), 'Backend must connect to redpanda container on internal port 9092');
      assert.ok(content.includes('ml-service:8000'), 'Backend must connect to ml-service container');
      assert.ok(content.includes('genai-service:8001'), 'Backend must connect to genai-service container');
      assert.ok(content.includes('qdrant:6333'), 'GenAI service must connect to qdrant container');
      assert.ok(content.includes('recoveriq-network'), 'Services must share recoveriq-network');
    });

    test('2.3 Healthchecks and container dependencies are configured', () => {
      const content = fs.readFileSync(composePath, 'utf-8');

      assert.ok(content.includes('/health/ready'), 'Healthchecks must query /health/ready probe');
      assert.ok(content.includes('service_healthy'), 'Depends_on must wait on service_healthy conditions');
      assert.ok(content.includes('recoveriq-user') || content.includes('recoveriq_user'), 'Postgres credentials must match database configuration');
    });
  });
});
