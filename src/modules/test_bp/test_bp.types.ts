import { ExchangeName } from '../bp/bp.types';

export interface TestBpResult {
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    averageBp: number;
    sampleCount: number;
}

export interface TestBpState {
    step: 'awaiting_coin' | 'awaiting_long' | 'awaiting_short' | 'calculating';
    coin?: string;
    longExchange?: ExchangeName;
    shortExchange?: ExchangeName;
}
