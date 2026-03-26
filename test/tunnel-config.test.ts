import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCH_ALL_SERVICE,
  createDefaultTunnelConfig,
  extractPublishedHostnames,
  removeIngressRule,
  upsertIngressRule
} from "../src/domain/tunnel-config";
import { TunnelConfigPayload } from "../src/types";

test("upsertIngressRule inserts a named publication before catch-all", () => {
  const config = upsertIngressRule(
    createDefaultTunnelConfig(),
    "p3000-abc123.dev.example.com",
    "http://host.docker.internal:3000/"
  );

  assert.equal(config.ingress.length, 2);
  assert.equal(config.ingress[0]?.hostname, "p3000-abc123.dev.example.com");
  assert.equal(config.ingress[1]?.service, CATCH_ALL_SERVICE);
});

test("upsertIngressRule replaces an existing hostname mapping", () => {
  const current: TunnelConfigPayload = {
    ingress: [
      { hostname: "p3000-abc123.dev.example.com", service: "http://old:3000/" },
      { service: CATCH_ALL_SERVICE }
    ]
  };

  const config = upsertIngressRule(current, "p3000-abc123.dev.example.com", "http://host.docker.internal:3000/");

  assert.equal(config.ingress.length, 2);
  assert.equal(config.ingress[0]?.service, "http://host.docker.internal:3000/");
});

test("removeIngressRule keeps catch-all rule intact", () => {
  const current: TunnelConfigPayload = {
    ingress: [
      { hostname: "p3000-abc123.dev.example.com", service: "http://host.docker.internal:3000/" },
      { hostname: "p8080-def456.dev.example.com", service: "http://docs:8080/" },
      { service: CATCH_ALL_SERVICE }
    ]
  };

  const config = removeIngressRule(current, "p3000-abc123.dev.example.com");

  assert.equal(config.ingress.length, 2);
  assert.equal(config.ingress[0]?.hostname, "p8080-def456.dev.example.com");
  assert.equal(config.ingress[1]?.service, CATCH_ALL_SERVICE);
});

test("extractPublishedHostnames ignores catch-all rules", () => {
  const hostnames = extractPublishedHostnames({
    ingress: [
      { hostname: "p3000-abc123.dev.example.com", service: "http://host.docker.internal:3000/" },
      { service: CATCH_ALL_SERVICE }
    ]
  });

  assert.deepEqual([...hostnames], ["p3000-abc123.dev.example.com"]);
});
