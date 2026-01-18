import { ExchangeName } from '../bp/bp.types';

export type ExchangeCode = 'B' | 'H' | 'P' | 'E' | 'L';

export interface MonitorTask {
    userId: number;
    coin: string;
    longEx: ExchangeName;
    shortEx: ExchangeName;
    intervalMin: number;
    totalDurationMin: number;
    startTime: number;
    timer?: NodeJS.Timeout;
}

export interface MonitorInput {
    coin: string;
    longExCode: ExchangeCode;
    shortExCode: ExchangeCode;
}

export const EXCHANGE_MAP: Record<string, ExchangeName> = {
    'b': 'Binance',
    'h': 'Hyperliquid',
    'p': 'Paradex',
    'e': 'Extended',
    'l': 'Lighter'
};
