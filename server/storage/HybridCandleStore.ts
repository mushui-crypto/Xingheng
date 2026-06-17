import fs from "node:fs/promises";
import path from "node:path";
import { createClient, type RedisClientType } from "redis";
import pg from "pg";
import type { Candle, CandleInterval } from "../types";
import type { CandleStore } from "./CandleStore";

type FileState = {
  current: Record<string, Candle>;
  history: Candle[];
};

const defaultState: FileState = {
  current: {},
  history: [],
};

export class HybridCandleStore implements CandleStore {
  private redis: RedisClientType | null = null;
  private pgPool: pg.Pool | null = null;
  private fileReady = false;

  constructor(private dataFile: string) {}

  async init() {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    await this.ensureFile();
    await this.initRedis();
    await this.initPostgres();
  }

  async saveCurrent(candle: Candle) {
    const key = this.currentKey(candle.symbol, candle.interval);
    if (this.redis) {
      await this.redis.set(key, JSON.stringify(candle));
      return;
    }

    const state = await this.readFileState();
    state.current[key] = candle;
    await this.writeFileState(state);
  }

  async getCurrent(symbol: string, interval: CandleInterval) {
    const key = this.currentKey(symbol, interval);
    if (this.redis) {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as Candle) : null;
    }

    const state = await this.readFileState();
    return state.current[key] ?? null;
  }

  async saveClosed(candle: Candle) {
    if (this.pgPool) {
      await this.pgPool.query(
        `insert into candles(symbol, interval, time, open, high, low, close, volume)
         values($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict(symbol, interval, time)
         do update set open = excluded.open, high = excluded.high, low = excluded.low,
                       close = excluded.close, volume = excluded.volume`,
        [candle.symbol, candle.interval, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume],
      );
      return;
    }

    const state = await this.readFileState();
    const index = state.history.findIndex(
      (item) => item.symbol === candle.symbol && item.interval === candle.interval && item.time === candle.time,
    );
    if (index >= 0) {
      state.history[index] = candle;
    } else {
      state.history.push(candle);
    }
    state.history = state.history.slice(-20_000);
    await this.writeFileState(state);
  }

  async getHistory(symbol: string, interval: CandleInterval, limit: number) {
    if (this.pgPool) {
      const result = await this.pgPool.query<Candle>(
        `select symbol, interval, time, open, high, low, close, volume
         from candles
         where symbol = $1 and interval = $2
         order by time desc
         limit $3`,
        [symbol, interval, limit],
      );
      return result.rows.reverse();
    }

    const state = await this.readFileState();
    return state.history
      .filter((item) => item.symbol === symbol && item.interval === interval)
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  private async initRedis() {
    if (!process.env.REDIS_URL) {
      return;
    }

    try {
      this.redis = createClient({ url: process.env.REDIS_URL });
      this.redis.on("error", (error) => console.error("[market] redis error", error.message));
      await this.redis.connect();
      console.log("[market] redis connected for current candles");
    } catch (error) {
      console.error("[market] redis unavailable, using file current candles", error);
      this.redis = null;
    }
  }

  private async initPostgres() {
    if (!process.env.DATABASE_URL) {
      return;
    }

    try {
      this.pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await this.pgPool.query(`
        create table if not exists candles (
          symbol text not null,
          interval text not null,
          time integer not null,
          open double precision not null,
          high double precision not null,
          low double precision not null,
          close double precision not null,
          volume double precision not null,
          primary key(symbol, interval, time)
        )
      `);
      console.log("[market] postgres connected for historical candles");
    } catch (error) {
      console.error("[market] postgres unavailable, using file candle history", error);
      this.pgPool = null;
    }
  }

  private currentKey(symbol: string, interval: CandleInterval) {
    return `current:${symbol}:${interval}`;
  }

  private async ensureFile() {
    if (this.fileReady) {
      return;
    }

    try {
      await fs.access(this.dataFile);
    } catch {
      await fs.writeFile(this.dataFile, JSON.stringify(defaultState, null, 2));
    }

    this.fileReady = true;
  }

  private async readFileState() {
    await this.ensureFile();
    try {
      return JSON.parse(await fs.readFile(this.dataFile, "utf-8")) as FileState;
    } catch {
      return { ...defaultState };
    }
  }

  private async writeFileState(state: FileState) {
    await fs.writeFile(this.dataFile, JSON.stringify(state, null, 2));
  }
}
