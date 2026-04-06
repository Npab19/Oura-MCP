import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callOuraApi, callOuraApiWithBody, type OuraApiError } from "./oura-client.js";

// --- Schema building blocks ---

const dateRangeSchema = {
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
  next_token: z.string().optional().describe("Pagination token for next page"),
};

const datetimeRangeSchema = {
  start_datetime: z
    .string()
    .optional()
    .describe("Start datetime (ISO 8601, e.g. 2024-01-01T00:00:00+00:00)"),
  end_datetime: z
    .string()
    .optional()
    .describe("End datetime (ISO 8601, e.g. 2024-01-02T00:00:00+00:00)"),
  next_token: z.string().optional().describe("Pagination token for next page"),
};

const documentIdSchema = {
  document_id: z.string().describe("The unique document ID"),
};

const paginationOnlySchema = {
  next_token: z.string().optional().describe("Pagination token for next page"),
};

// --- Helper to extract token from extra ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getToken(extra: any): string {
  const auth = (extra as { authInfo?: { token?: string } }).authInfo;
  if (!auth?.token) {
    throw new Error("Not authenticated. Please complete the OAuth flow first.");
  }
  return auth.token;
}

// --- Endpoint configs ---

interface CollectionEndpoint {
  name: string;
  description: string;
  path: string;
  schemaType: "dateRange" | "datetimeRange" | "paginationOnly" | "none";
}

interface DocumentEndpoint {
  name: string;
  description: string;
  path: string;
}

const collectionEndpoints: CollectionEndpoint[] = [
  {
    name: "get_personal_info",
    description:
      "Get personal info for the authenticated Oura user (age, weight, height, email, etc.)",
    path: "/v2/usercollection/personal_info",
    schemaType: "none",
  },
  {
    name: "get_daily_activity",
    description:
      "Get daily activity summaries including steps, calories, movement, and activity scores",
    path: "/v2/usercollection/daily_activity",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_cardiovascular_age",
    description: "Get daily cardiovascular age estimates",
    path: "/v2/usercollection/daily_cardiovascular_age",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_readiness",
    description:
      "Get daily readiness scores and contributors (HRV, body temperature, sleep, etc.)",
    path: "/v2/usercollection/daily_readiness",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_resilience",
    description:
      "Get daily resilience data showing recovery and stress tolerance",
    path: "/v2/usercollection/daily_resilience",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_sleep",
    description:
      "Get daily sleep summaries including sleep score, duration, and contributors",
    path: "/v2/usercollection/daily_sleep",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_spo2",
    description: "Get daily SpO2 (blood oxygen) average recorded during sleep",
    path: "/v2/usercollection/daily_spo2",
    schemaType: "dateRange",
  },
  {
    name: "get_daily_stress",
    description:
      "Get daily stress data including stress levels throughout the day",
    path: "/v2/usercollection/daily_stress",
    schemaType: "dateRange",
  },
  {
    name: "get_enhanced_tags",
    description:
      "Get enhanced tags with additional context and structured data",
    path: "/v2/usercollection/enhanced_tag",
    schemaType: "dateRange",
  },
  {
    name: "get_heart_rate",
    description:
      "Get heart rate time series data (5-minute intervals). Use datetime parameters for filtering.",
    path: "/v2/usercollection/heartrate",
    schemaType: "datetimeRange",
  },
  {
    name: "get_rest_mode_periods",
    description:
      "Get rest mode periods when the user had rest mode enabled on their ring",
    path: "/v2/usercollection/rest_mode_period",
    schemaType: "dateRange",
  },
  {
    name: "get_ring_configuration",
    description:
      "Get ring configuration details (model, firmware, hardware, design, etc.)",
    path: "/v2/usercollection/ring_configuration",
    schemaType: "paginationOnly",
  },
  {
    name: "get_sessions",
    description:
      "Get guided and unguided mindfulness/meditation sessions from the Oura app",
    path: "/v2/usercollection/session",
    schemaType: "dateRange",
  },
  {
    name: "get_sleep",
    description:
      "Get detailed sleep period data including stages, HRV, movement, and timing",
    path: "/v2/usercollection/sleep",
    schemaType: "dateRange",
  },
  {
    name: "get_sleep_time",
    description:
      "Get recommended bedtime windows and sleep time recommendations",
    path: "/v2/usercollection/sleep_time",
    schemaType: "dateRange",
  },
  {
    name: "get_tags",
    description: "Get user-entered tags/notes from the Oura app",
    path: "/v2/usercollection/tag",
    schemaType: "dateRange",
  },
  {
    name: "get_vo2_max",
    description: "Get VO2 max estimates derived from walking and activity data",
    path: "/v2/usercollection/vO2_max",
    schemaType: "dateRange",
  },
  {
    name: "get_workouts",
    description:
      "Get auto-detected and user-entered workout summaries (type, duration, calories, HR, etc.)",
    path: "/v2/usercollection/workout",
    schemaType: "dateRange",
  },
];

// Document endpoints for getting single records by ID
// Derived from collection endpoints (exclude personal_info and heartrate which don't have single-doc endpoints)
const documentEndpoints: DocumentEndpoint[] = [
  {
    name: "get_daily_activity_by_id",
    description: "Get a single daily activity document by ID",
    path: "/v2/usercollection/daily_activity",
  },
  {
    name: "get_daily_cardiovascular_age_by_id",
    description: "Get a single daily cardiovascular age document by ID",
    path: "/v2/usercollection/daily_cardiovascular_age",
  },
  {
    name: "get_daily_readiness_by_id",
    description: "Get a single daily readiness document by ID",
    path: "/v2/usercollection/daily_readiness",
  },
  {
    name: "get_daily_resilience_by_id",
    description: "Get a single daily resilience document by ID",
    path: "/v2/usercollection/daily_resilience",
  },
  {
    name: "get_daily_sleep_by_id",
    description: "Get a single daily sleep document by ID",
    path: "/v2/usercollection/daily_sleep",
  },
  {
    name: "get_daily_spo2_by_id",
    description: "Get a single daily SpO2 document by ID",
    path: "/v2/usercollection/daily_spo2",
  },
  {
    name: "get_daily_stress_by_id",
    description: "Get a single daily stress document by ID",
    path: "/v2/usercollection/daily_stress",
  },
  {
    name: "get_enhanced_tag_by_id",
    description: "Get a single enhanced tag document by ID",
    path: "/v2/usercollection/enhanced_tag",
  },
  {
    name: "get_rest_mode_period_by_id",
    description: "Get a single rest mode period document by ID",
    path: "/v2/usercollection/rest_mode_period",
  },
  {
    name: "get_ring_configuration_by_id",
    description: "Get a single ring configuration document by ID",
    path: "/v2/usercollection/ring_configuration",
  },
  {
    name: "get_session_by_id",
    description: "Get a single session document by ID",
    path: "/v2/usercollection/session",
  },
  {
    name: "get_sleep_by_id",
    description: "Get a single sleep document by ID",
    path: "/v2/usercollection/sleep",
  },
  {
    name: "get_sleep_time_by_id",
    description: "Get a single sleep time document by ID",
    path: "/v2/usercollection/sleep_time",
  },
  {
    name: "get_tag_by_id",
    description: "Get a single tag document by ID",
    path: "/v2/usercollection/tag",
  },
  {
    name: "get_vo2_max_by_id",
    description: "Get a single VO2 max document by ID",
    path: "/v2/usercollection/vO2_max",
  },
  {
    name: "get_workout_by_id",
    description: "Get a single workout document by ID",
    path: "/v2/usercollection/workout",
  },
];

function getInputSchema(schemaType: string) {
  switch (schemaType) {
    case "dateRange":
      return dateRangeSchema;
    case "datetimeRange":
      return datetimeRangeSchema;
    case "paginationOnly":
      return paginationOnlySchema;
    default:
      return undefined;
  }
}

function getParams(
  args: Record<string, string | undefined>,
  schemaType: string
): Record<string, string | undefined> | undefined {
  switch (schemaType) {
    case "dateRange":
      return {
        start_date: args.start_date,
        end_date: args.end_date,
        next_token: args.next_token,
      };
    case "datetimeRange":
      return {
        start_datetime: args.start_datetime,
        end_datetime: args.end_datetime,
        next_token: args.next_token,
      };
    case "paginationOnly":
      return { next_token: args.next_token };
    default:
      return undefined;
  }
}

export function registerAllTools(server: McpServer): void {
  // Register collection endpoints
  for (const endpoint of collectionEndpoints) {
    const schema = getInputSchema(endpoint.schemaType);

    if (schema) {
      server.registerTool(
        endpoint.name,
        {
          description: endpoint.description,
          inputSchema: schema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args: Record<string, string | undefined>, extra) => {
          try {
            const token = getToken(extra);
            const params = getParams(args, endpoint.schemaType);
            const data = await callOuraApi(endpoint.path, token, params);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            };
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
            console.error(`[${endpoint.name}] Error:`, message);
            return {
              content: [{ type: "text" as const, text: `Error: ${message}` }],
              isError: true,
            };
          }
        }
      );
    } else {
      // No input schema (personal_info)
      server.registerTool(
        endpoint.name,
        {
          description: endpoint.description,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (extra: unknown) => {
          try {
            const token = getToken(extra);
            const data = await callOuraApi(endpoint.path, token);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            };
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
            console.error(`[${endpoint.name}] Error:`, message);
            return {
              content: [{ type: "text" as const, text: `Error: ${message}` }],
              isError: true,
            };
          }
        }
      );
    }
  }

  // Register single-document endpoints
  for (const endpoint of documentEndpoints) {
    server.registerTool(
      endpoint.name,
      {
        description: endpoint.description,
        inputSchema: documentIdSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: { document_id: string }, extra) => {
        try {
          const token = getToken(extra);
          const data = await callOuraApi(
            `${endpoint.path}/${args.document_id}`,
            token
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
          console.error(`[${endpoint.name}] Error:`, message);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  // Register webhook endpoints
  server.registerTool(
    "list_webhook_subscriptions",
    {
      description: "List all webhook subscriptions for your Oura application",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (extra: unknown) => {
      try {
        const token = getToken(extra);
        const data = await callOuraApi(
          "/v2/webhook/subscription",
          token
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[list_webhook_subscriptions] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "create_webhook_subscription",
    {
      description:
        "Create a new webhook subscription to receive Oura data updates",
      inputSchema: {
        callback_url: z.string().describe("The URL to receive webhook events"),
        verification_token: z
          .string()
          .describe("Token used to verify webhook delivery"),
        event_type: z
          .enum(["create", "update", "delete"])
          .describe("Type of event to subscribe to"),
        data_type: z
          .enum([
            "tag",
            "enhanced_tag",
            "workout",
            "session",
            "daily_sleep",
            "daily_readiness",
            "daily_activity",
            "daily_spo2",
            "sleep",
            "daily_stress",
            "daily_resilience",
            "daily_cardiovascular_age",
            "vO2_max",
            "rest_mode_period",
          ])
          .describe("The data type to subscribe to"),
      },
    },
    async (
      args: {
        callback_url: string;
        verification_token: string;
        event_type: string;
        data_type: string;
      },
      extra
    ) => {
      try {
        const token = getToken(extra);
        const data = await callOuraApiWithBody(
          "/v2/webhook/subscription",
          "POST",
          token,
          {
            callback_url: args.callback_url,
            verification_token: args.verification_token,
            event_type: args.event_type,
            data_type: args.data_type,
          }
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[create_webhook_subscription] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_webhook_subscription",
    {
      description: "Get a specific webhook subscription by ID",
      inputSchema: {
        id: z.string().describe("The webhook subscription ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { id: string }, extra) => {
      try {
        const token = getToken(extra);
        const data = await callOuraApi(
          `/v2/webhook/subscription/${args.id}`,
          token
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[get_webhook_subscription] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "update_webhook_subscription",
    {
      description: "Update an existing webhook subscription",
      inputSchema: {
        id: z.string().describe("The webhook subscription ID"),
        callback_url: z
          .string()
          .optional()
          .describe("New callback URL"),
        verification_token: z
          .string()
          .optional()
          .describe("New verification token"),
        event_type: z
          .enum(["create", "update", "delete"])
          .optional()
          .describe("New event type"),
        data_type: z.string().optional().describe("New data type"),
      },
    },
    async (
      args: {
        id: string;
        callback_url?: string;
        verification_token?: string;
        event_type?: string;
        data_type?: string;
      },
      extra
    ) => {
      try {
        const token = getToken(extra);
        const body: Record<string, string> = {};
        if (args.callback_url) body.callback_url = args.callback_url;
        if (args.verification_token)
          body.verification_token = args.verification_token;
        if (args.event_type) body.event_type = args.event_type;
        if (args.data_type) body.data_type = args.data_type;

        const data = await callOuraApiWithBody(
          `/v2/webhook/subscription/${args.id}`,
          "PUT",
          token,
          body
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[update_webhook_subscription] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_webhook_subscription",
    {
      description: "Delete a webhook subscription",
      inputSchema: {
        id: z.string().describe("The webhook subscription ID"),
      },
    },
    async (args: { id: string }, extra) => {
      try {
        const token = getToken(extra);
        const data = await callOuraApiWithBody(
          `/v2/webhook/subscription/${args.id}`,
          "DELETE",
          token
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[delete_webhook_subscription] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "renew_webhook_subscription",
    {
      description:
        "Renew a webhook subscription to extend its expiration date",
      inputSchema: {
        id: z.string().describe("The webhook subscription ID"),
      },
    },
    async (args: { id: string }, extra) => {
      try {
        const token = getToken(extra);
        const data = await callOuraApiWithBody(
          `/v2/webhook/subscription/renew/${args.id}`,
          "PUT",
          token
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : (error as OuraApiError)?.detail ?? String(error);
        console.error(`[renew_webhook_subscription] Error:`, message);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
