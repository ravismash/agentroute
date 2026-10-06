import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** One disposable Postgres per test run; each test file creates its own database in it. */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  project.provide("adminDatabaseUrl", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
