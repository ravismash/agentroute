import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

let redis: StartedTestContainer | undefined;

/** One disposable Redis per test run; each test uses its own key prefix. */
export async function setup(project: TestProject): Promise<void> {
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  project.provide("redisUrl", `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
}

export async function teardown(): Promise<void> {
  await redis?.stop();
}
