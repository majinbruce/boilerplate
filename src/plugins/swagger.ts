import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { config } from "../config/index.ts";

/**
 * The docs are generated from the same Zod schemas that validate requests, so
 * they cannot drift: changing a field changes validation, serialization, the
 * TypeScript type and this page in one edit.
 */
export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "API",
          description: "Fastify + TypeScript + PostgreSQL boilerplate",
          version: "1.0.0",
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });

    app.log.info(
      `API docs available at http://${config.server.host}:${config.server.port}/docs`
    );
  },
  { name: "swagger" }
);
