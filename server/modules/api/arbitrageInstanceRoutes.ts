import type express from "express";
import type { ArbitrageInstanceQueryService } from "../cex/arbitrage-instance/ArbitrageInstanceQueryService";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { InstanceHedgeDeltaService } from "../arbitrage-execution/InstanceHedgeDeltaService";
import type { ArbitragePositionPresentationService } from "../arbitrage-position/ArbitragePositionPresentationService";

export function registerArbitrageInstanceRoutes(
  app: express.Express,
  query: ArbitrageInstanceQueryService,
  verification?: Pick<ArbitragePositionVerificationService, "verify">,
  hedgeDelta?: Pick<InstanceHedgeDeltaService, "derive">,
  presentation?: Pick<ArbitragePositionPresentationService, "present">,
) {
  app.get("/api/arbitrage-instances/active", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(query.listActive(userId(request)));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/arbitrage-instances/history", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(query.listHistory(userId(request), {
        page: positiveInteger(request.query.page, "page", 1),
        limit: positiveInteger(request.query.limit, "limit", 50),
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  if (presentation) {
    app.get("/api/arbitrage-instances/presentation", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const authenticatedUserId = userId(request);
        response.json(await presentation.present(query.listActive(authenticatedUserId)));
      } catch (error) {
        if (error instanceof ArbitrageInstanceRouteError) {
          sendError(response, error);
          return;
        }
        response.status(503).json({
          category: "arbitrage_position_presentation_unavailable",
          message: "Arbitrage position presentation is temporarily unavailable.",
        });
      }
    });
  }

  if (verification) {
    app.get("/api/arbitrage-instances/:arbitrageId/verification", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const arbitrageId = pathValue(request.params.arbitrageId, "arbitrageId");
        const result = await verification.verify(userId(request), arbitrageId);
        if (!result) {
          response.status(404).json({
            category: "arbitrage_instance_not_found",
            message: "Arbitrage instance was not found for the authenticated user.",
          });
          return;
        }
        response.json(result);
      } catch (error) {
        if (error instanceof ArbitrageInstanceRouteError) {
          sendError(response, error);
          return;
        }
        response.status(503).json({
          category: "arbitrage_position_verification_unavailable",
          message: "Arbitrage position verification is temporarily unavailable.",
        });
      }
    });
  }

  if (hedgeDelta) {
    app.get("/api/arbitrage-instances/:arbitrageId/hedge-delta", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const arbitrageId = pathValue(request.params.arbitrageId, "arbitrageId");
        const result = await hedgeDelta.derive(userId(request), arbitrageId);
        if (!result) {
          response.status(404).json({
            category: "arbitrage_instance_not_found",
            message: "Arbitrage instance was not found for the authenticated user.",
          });
          return;
        }
        response.json(result);
      } catch (error) {
        if (error instanceof ArbitrageInstanceRouteError) {
          sendError(response, error);
          return;
        }
        response.status(503).json({
          category: "instance_hedge_delta_unavailable",
          message: "Instance hedge delta is temporarily unavailable.",
        });
      }
    });
  }

  app.get("/api/arbitrage-instances/:arbitrageId", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const arbitrageId = pathValue(request.params.arbitrageId, "arbitrageId");
      const instance = query.getById(userId(request), arbitrageId);
      if (!instance) {
        response.status(404).json({
          category: "arbitrage_instance_not_found",
          message: "Arbitrage instance was not found for the authenticated user.",
        });
        return;
      }
      response.json(instance);
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new ArbitrageInstanceRouteError("authentication_required", "User authentication is required.");
  return request.user.id;
}

function positiveInteger(value: unknown, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !/^\d+$/u.test(normalized)) {
    throw new ArbitrageInstanceRouteError("invalid_pagination", `${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ArbitrageInstanceRouteError("invalid_pagination", `${name} must be a positive integer.`);
  }
  return parsed;
}

function pathValue(value: string | string[] | undefined, name: string) {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !normalized.trim() || normalized.length > 200) {
    throw new ArbitrageInstanceRouteError("invalid_arbitrage_instance_id", `${name} is invalid.`);
  }
  return normalized.trim();
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageInstanceRouteError) {
    response.status(error.category === "authentication_required" ? 401 : 400).json({
      category: error.category,
      message: error.message,
    });
    return;
  }
  response.status(400).json({
    category: "arbitrage_instance_query_failed",
    message: error instanceof Error ? error.message : "Arbitrage instance query failed.",
  });
}

class ArbitrageInstanceRouteError extends Error {
  constructor(
    readonly category: "authentication_required" | "invalid_pagination" | "invalid_arbitrage_instance_id",
    message: string,
  ) {
    super(message);
  }
}
