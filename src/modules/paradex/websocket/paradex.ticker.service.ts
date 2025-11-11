import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ParadexTickerService {
    private ws: WebSocket | null = null;
    private subscriptionId: number = 1;

    constructor() {
        console.log('ParadexTickerService initialized.');
    }

    public start(symbol: string, callback: PriceUpdateCallback): void {
        if (this.ws) {
            console.warn('Paradex WebSocket connection is already active.');
            return;
        }

        // --- ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗДЕСЬ ---
        // Используем точный URL из документации, включая /v1/
        const connectionUrl = 'wss://ws.api.prod.paradex.trade/v1?/';
        this.ws = new WebSocket(connectionUrl);

        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            console.log(`Connected to Paradex WebSocket at ${connectionUrl} for ${symbol}.`);

            const subscriptionMessage = {
                jsonrpc: "2.0",
                method: "subscribe",
                params: {
                    // Формат канала bbo.{market_symbol} верный
                    channel: `bbo.${symbol.toUpperCase()}`
                },
                id: this.subscriptionId++
            };
            currentConnection.send(JSON.stringify(subscriptionMessage));
            console.log('Paradex subscription message sent:', JSON.stringify(subscriptionMessage));
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.method === 'subscription' && message.params && message.params.data) {
                    const priceData = message.params.data;
                    const bestBid = priceData.bid;
                    const bestAsk = priceData.ask;

                    if (bestBid && bestAsk) {
                        callback(bestBid, bestAsk);
                    }
                }
            } catch (error) {
                console.error('Error parsing Paradex message:', error);
            }
        });

        currentConnection.on('close', () => {
            console.log('Paradex WebSocket disconnected.');
            this.ws = null;
        });

        currentConnection.on('error', (error) => {
            console.error('Paradex WebSocket error:', error);
            this.ws = null;
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Paradex WebSocket...');
            const unsubscribeMessage = {
                jsonrpc: "2.0",
                method: "unsubscribe_all",
                params: {},
                id: this.subscriptionId++
            };
            this.ws.send(JSON.stringify(unsubscribeMessage));
            this.ws.close();
            this.ws = null;
        } else {
            console.warn('Attempted to stop a non-existent Paradex WebSocket connection.');
        }
    }
}