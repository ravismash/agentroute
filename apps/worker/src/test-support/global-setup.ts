import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    redisUrl: string;
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new GenericContainer("redis:7-alpine").withExposedPorts(6379).start(),
  ]);
  project.provide("adminDatabaseUrl", postgres.getConnectionUri());
  project.provide("redisUrl", `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
}
