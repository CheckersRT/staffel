import type {
  StageSyncState,
  StageSyncTask,
} from "../application/ports.js";
import type {
  TrackerDiagnostic,
  TrackerPort,
} from "../application/tracker.js";
import type { TrelloTrackerConfig } from "../core/types.js";

export interface TrelloCredentials {
  readonly boardId: string;
  readonly apiKey: string;
  readonly token: string;
}

export interface TrackerHttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly body?: Readonly<Record<string, string>>;
}

export interface TrackerHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface TrackerHttpPort {
  request(input: TrackerHttpRequest): Promise<TrackerHttpResponse>;
}

interface TrelloCard {
  readonly id: string;
  readonly name: string;
  readonly idList: string;
  readonly url?: string;
}

export class TrackerAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrackerAdapterError";
    this.code = code;
  }
}

export class NoTrackerAdapter implements TrackerPort {
  readonly provider = "none" as const;

  inspect(): StageSyncState {
    return { position: null, reference: null };
  }

  sync(_task: StageSyncTask, destination: string): StageSyncState {
    return { position: destination, reference: null };
  }

  diagnose(): readonly TrackerDiagnostic[] {
    return [{ ok: true, code: "tracker.disabled", message: "External tracker integration is disabled." }];
  }
}

export class FetchTrackerHttpAdapter implements TrackerHttpPort {
  async request(input: TrackerHttpRequest): Promise<TrackerHttpResponse> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.body
        ? { "content-type": "application/x-www-form-urlencoded" }
        : undefined,
      body: input.body ? new URLSearchParams(input.body).toString() : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Trello error responses are occasionally plain text; preserve them verbatim.
    }
    return { status: response.status, body };
  }
}

export class TrelloTrackerAdapter implements TrackerPort {
  readonly provider = "trello" as const;
  readonly #config: TrelloTrackerConfig;
  readonly #credentials: TrelloCredentials;
  readonly #http: TrackerHttpPort;
  readonly #baseUrl: string;

  constructor(
    config: TrelloTrackerConfig,
    credentials: TrelloCredentials,
    http: TrackerHttpPort = new FetchTrackerHttpAdapter(),
    baseUrl = "https://api.trello.com/1"
  ) {
    this.#config = config;
    this.#credentials = credentials;
    this.#http = http;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async inspect(task: StageSyncTask): Promise<StageSyncState> {
    const cards = await this.#cards();
    const matches = cards.filter((card) => card.name === task.title);
    if (matches.length > 1) {
      throw new TrackerAdapterError(
        "tracker.ambiguous_task",
        `Trello contains multiple open cards named ${task.title}.`
      );
    }
    const card = matches[0];
    if (!card) return { position: null, reference: null };
    const position = Object.entries(this.#config.listIds)
      .find(([, id]) => id === card.idList)?.[0];
    if (!position) {
      throw new TrackerAdapterError(
        "tracker.unmapped_list",
        `Trello card ${card.id} is in unconfigured list ${card.idList}.`
      );
    }
    return { position, reference: card.url ?? `trello:${card.id}` };
  }

  async sync(task: StageSyncTask, destination: string): Promise<StageSyncState> {
    const listId = this.#config.listIds[destination];
    if (!listId) {
      throw new TrackerAdapterError(
        "tracker.unmapped_destination",
        `No Trello list id is configured for ${destination}.`
      );
    }
    const current = await this.inspect(task);
    if (current.position === destination) return current;
    const cardId = referenceCardId(current.reference);
    if (cardId) {
      const card = await this.#write(`/cards/${encodeURIComponent(cardId)}`, "PUT", {
        idList: listId,
      });
      return { position: destination, reference: cardReference(card) };
    }
    const labelId = this.#config.taskTypeLabelIds[task.taskType];
    const body: Record<string, string> = {
      idList: listId,
      name: task.title,
      desc: `Staffel task packet: ${task.packetPath}`,
    };
    if (labelId) body.idLabels = labelId;
    const card = await this.#write("/cards", "POST", body);
    return { position: destination, reference: cardReference(card) };
  }

  diagnose(): readonly TrackerDiagnostic[] {
    const diagnostics: TrackerDiagnostic[] = [];
    for (const [code, value] of [
      ["tracker.board_id", this.#credentials.boardId],
      ["tracker.api_key", this.#credentials.apiKey],
      ["tracker.token", this.#credentials.token],
    ] as const) {
      diagnostics.push({
        ok: Boolean(value),
        code,
        message: value ? "Configured." : "Missing required Trello credential.",
      });
    }
    return diagnostics;
  }

  async #cards(): Promise<readonly TrelloCard[]> {
    if (this.diagnose().some((item) => !item.ok)) {
      throw new TrackerAdapterError(
        "tracker.credentials_missing",
        "Trello credentials are missing from the configured environment variables."
      );
    }
    const body = await this.#read(
      `/boards/${encodeURIComponent(this.#credentials.boardId)}/cards`,
      { fields: "id,name,idList,url" }
    );
    if (!Array.isArray(body)) {
      throw new TrackerAdapterError("tracker.invalid_response", "Trello cards response is not an array.");
    }
    return body.map(parseCard);
  }

  async #read(pathname: string, query: Readonly<Record<string, string>>): Promise<unknown> {
    const url = this.#url(pathname, query);
    const response = await this.#http.request({ method: "GET", url });
    return this.#responseBody(response, "read");
  }

  async #write(
    pathname: string,
    method: "POST" | "PUT",
    body: Readonly<Record<string, string>>
  ): Promise<TrelloCard> {
    const response = await this.#http.request({
      method,
      url: this.#url(pathname),
      body,
    });
    return parseCard(this.#responseBody(response, "write"));
  }

  #url(pathname: string, query: Readonly<Record<string, string>> = {}): string {
    const url = new URL(`${this.#baseUrl}${pathname}`);
    for (const [key, value] of Object.entries({
      ...query,
      key: this.#credentials.apiKey,
      token: this.#credentials.token,
    })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  #responseBody(response: TrackerHttpResponse, operation: string): unknown {
    if (response.status < 200 || response.status >= 300) {
      throw new TrackerAdapterError(
        "tracker.request_failed",
        `Trello ${operation} failed with HTTP ${response.status}.`
      );
    }
    return response.body;
  }
}

export function trelloCredentialsFromEnvironment(
  config: TrelloTrackerConfig,
  environment: NodeJS.ProcessEnv = process.env
): TrelloCredentials {
  return {
    boardId: environment[config.boardIdEnvironmentVariable] ?? "",
    apiKey: environment[config.apiKeyEnvironmentVariable] ?? "",
    token: environment[config.tokenEnvironmentVariable] ?? "",
  };
}

function parseCard(value: unknown): TrelloCard {
  if (!isRecord(value)) {
    throw new TrackerAdapterError("tracker.invalid_response", "Trello card response is not an object.");
  }
  for (const field of ["id", "name", "idList"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TrackerAdapterError("tracker.invalid_response", `Trello card is missing ${field}.`);
    }
  }
  return {
    id: value.id as string,
    name: value.name as string,
    idList: value.idList as string,
    url: typeof value.url === "string" ? value.url : undefined,
  };
}

function cardReference(card: TrelloCard): string {
  return card.url ?? `trello:${card.id}`;
}

function referenceCardId(reference: string | null): string | null {
  if (!reference) return null;
  if (reference.startsWith("trello:")) return reference.slice("trello:".length);
  const match = reference.match(/\/c\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
