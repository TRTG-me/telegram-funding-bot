export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

export interface TradeStatusData {
    filledQty: number;
    totalQty: number;
    longAsk: number;
    shortBid: number;
    currentBp: number;
    status: 'WAITING_PRICES' | 'WAITING_BP' | 'TRADING' | 'FINISHED';
}

export interface TradeSessionConfig {
    userId: number;
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    totalQuantity: number;
    stepQuantity: number;
    targetBp: number;
    onUpdate: (msg: string) => Promise<void>;
    onStatusUpdate?: (data: TradeStatusData) => Promise<void>;
    onFinished: () => Promise<void>; // Исправил на Promise, т.к. там await
}