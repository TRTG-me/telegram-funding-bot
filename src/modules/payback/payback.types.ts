import { ExchangeName } from '../bp/bp.types';

export interface PayBackResult {
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    averageBp: number;
    sampleCount: number;
    totalCostBp: number;
    dailyReturnBp: number;
    paybackDays: number;
    apr1d: number;
    apr3d: number;
}

export interface PayBackState {
    step: 'awaiting_coin' | 'awaiting_long' | 'awaiting_short' | 'calculating';
    coin?: string;
    longExchange?: ExchangeName;
    shortExchange?: ExchangeName;
}
