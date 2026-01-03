export interface BestOpportunity {
    coin: string;
    pair: string;
    diffs: number[];
    sortVal: number;
}

export interface ComparisonResult {
    pair: string;
    results: {
        period: string;
        apr1: number;
        apr2: number;
        diff: number;
    }[];
}

export interface FundingHistory {
    date: number;
    rate: number;
}

export interface CoinAnalysisResponse {
    success: boolean;
    coin: string;
    availableExchanges: string[];
    selectedExchanges: string[];
    comparisons: ComparisonResult[];
    histories: { exchange: string, history: FundingHistory[] }[];
}

export interface FundingApiState {
    step: 'idle' | 'awaiting_coin' | 'selecting_exchanges';
    coin?: string;
    selectedExchanges: string[];
    availableExchanges: string[];
}
