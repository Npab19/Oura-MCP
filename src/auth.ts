import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const OURA_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const OURA_SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "tag",
  "session",
  "spo2",
];

interface AuthSession {
  mcpClientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
}

interface TokenMapping {
  ouraAccessToken: string;
  ouraRefreshToken?: string;
  expiresAt?: number;
  clientId: string;
}

export class OuraOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private authSessions = new Map<string, AuthSession>();
  private mcpCodes = new Map<string, TokenMapping>();
  private tokenMappings = new Map<string, TokenMapping>();

  private ouraClientId: string;
  private ouraClientSecret: string;
  private serverUrl: string;

  skipLocalPkceValidation = true;

  constructor(ouraClientId: string, ouraClientSecret: string, serverUrl: string) {
    this.ouraClientId = ouraClientId;
    this.ouraClientSecret = ouraClientSecret;
    this.serverUrl = serverUrl;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: (
        clientData: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
      ) => {
        const clientId = randomUUID();
        const client: OAuthClientInformationFull = {
          ...clientData,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(clientId, client);
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate internal state to map Oura callback back to MCP client
    const internalState = randomUUID();

    this.authSessions.set(internalState, {
      mcpClientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
    });

    // Redirect to Oura's authorization page
    const ouraAuthUrl = new URL(OURA_AUTH_URL);
    ouraAuthUrl.searchParams.set("client_id", this.ouraClientId);
    ouraAuthUrl.searchParams.set("response_type", "code");
    ouraAuthUrl.searchParams.set(
      "redirect_uri",
      `${this.serverUrl}/oura/callback`
    );
    ouraAuthUrl.searchParams.set("scope", OURA_SCOPES.join(" "));
    ouraAuthUrl.searchParams.set("state", internalState);

    res.redirect(ouraAuthUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    // Look up the original code challenge from the auth session
    // We stored it when we got the callback and created the MCP code
    const mapping = this.mcpCodes.get(authorizationCode);
    if (!mapping) {
      return "";
    }
    // Find the auth session that created this code
    for (const [, session] of this.authSessions) {
      if (session.mcpClientId === mapping.clientId) {
        return session.codeChallenge;
      }
    }
    return "";
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string
  ): Promise<OAuthTokens> {
    const mapping = this.mcpCodes.get(authorizationCode);
    if (!mapping) {
      throw new Error("Invalid authorization code");
    }
    this.mcpCodes.delete(authorizationCode);

    // Store the token mapping using the Oura access token as the key
    // (since that's what will come back as the Bearer token)
    this.tokenMappings.set(mapping.ouraAccessToken, mapping);

    return {
      access_token: mapping.ouraAccessToken,
      token_type: "Bearer",
      expires_in: mapping.expiresAt
        ? mapping.expiresAt - Math.floor(Date.now() / 1000)
        : undefined,
      refresh_token: mapping.ouraRefreshToken,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    // Exchange the refresh token with Oura
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.ouraClientId,
      client_secret: this.ouraClientSecret,
      refresh_token: refreshToken,
    });

    const response = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Oura token refresh failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    };

    // Update token mapping
    const mapping: TokenMapping = {
      ouraAccessToken: data.access_token,
      ouraRefreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? Math.floor(Date.now() / 1000) + data.expires_in
        : undefined,
      clientId: _client.client_id,
    };
    this.tokenMappings.set(data.access_token, mapping);

    return {
      access_token: data.access_token,
      token_type: "Bearer",
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Verify the token by calling a lightweight Oura endpoint
    const response = await fetch(
      "https://api.ouraring.com/v2/usercollection/personal_info",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[verifyAccessToken] Oura returned ${response.status}: ${text}`);
      throw new Error(`Invalid or expired Oura access token (${response.status})`);
    }

    // Consume the response body
    await response.json();

    const mapping = this.tokenMappings.get(token);
    return {
      token,
      clientId: mapping?.clientId ?? "unknown",
      scopes: OURA_SCOPES,
      expiresAt: mapping?.expiresAt ?? Math.floor(Date.now() / 1000) + 86400,
    };
  }

  /**
   * Handle the callback from Oura after the user authorizes.
   * This exchanges the Oura code for tokens, then redirects
   * back to the MCP client with an MCP authorization code.
   */
  async handleOuraCallback(
    code: string,
    state: string,
    res: Response
  ): Promise<void> {
    const session = this.authSessions.get(state);
    if (!session) {
      res.status(400).send("Invalid state parameter");
      return;
    }

    // Exchange Oura code for tokens
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.ouraClientId,
      client_secret: this.ouraClientSecret,
      code,
      redirect_uri: `${this.serverUrl}/oura/callback`,
    });

    const tokenResponse = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text().catch(() => "");
      res.status(502).send(`Failed to exchange Oura code: ${text}`);
      return;
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    };

    // Generate an MCP authorization code
    const mcpCode = randomUUID();
    this.mcpCodes.set(mcpCode, {
      ouraAccessToken: tokenData.access_token,
      ouraRefreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined,
      clientId: session.mcpClientId,
    });

    // Redirect back to the MCP client
    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set("code", mcpCode);
    if (session.state) {
      redirectUrl.searchParams.set("state", session.state);
    }

    // Clean up the auth session
    this.authSessions.delete(state);

    res.redirect(redirectUrl.toString());
  }
}

/**
 * Creates an Express router for the Oura OAuth callback endpoint.
 */
export function createOuraCallbackRouter(provider: OuraOAuthProvider): Router {
  const router = Router();

  router.get("/oura/callback", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      res.status(400).send(`Oura authorization error: ${error}`);
      return;
    }

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    try {
      await provider.handleOuraCallback(code, state, res);
    } catch (err) {
      console.error("Error handling Oura callback:", err);
      res.status(500).send("Internal server error during OAuth callback");
    }
  });

  return router;
}
