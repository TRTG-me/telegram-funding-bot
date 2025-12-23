export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

export interface BpCalculationData {
    longPrice: number;
    shortPrice: number;
    bpValue: number;
}