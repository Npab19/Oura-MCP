const OURA_API_BASE = "https://api.ouraring.com";

export interface OuraApiError {
  status: number;
  detail: string;
}

export async function callOuraApi(
  path: string,
  token: string,
  params?: Record<string, string | undefined>
): Promise<unknown> {
  const url = new URL(path, OURA_API_BASE);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw {
      status: response.status,
      detail: `Oura API error ${response.status}: ${text}`,
    } as OuraApiError;
  }

  return response.json();
}

export async function callOuraApiWithBody(
  path: string,
  method: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<unknown> {
  const url = new URL(path, OURA_API_BASE);

  const reqHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };

  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  const init: RequestInit = {
    method,
    headers: reqHeaders,
  };

  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), init);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw {
      status: response.status,
      detail: `Oura API error ${response.status}: ${text}`,
    } as OuraApiError;
  }

  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}
