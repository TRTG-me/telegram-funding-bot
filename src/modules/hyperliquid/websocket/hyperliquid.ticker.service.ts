import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class HyperliquidTickerService {
    private ws: WebSocket | null = null;

    constructor() {
        console.log('HyperliquidTickerService initialized.');
    }

    public start(symbol: string, callback: PriceUpdateCallback): void {
        if (this.ws) {
            console.warn('Hyperliquid WebSocket connection is already active.');
            return;
        }

        this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

        // --- ГЛАВНОЕ ИСПРАВЛЕНИЕ ---
        // 1. Мы создаем локальную константу и TypeScript видит, что она не null.
        const currentConnection = this.ws;

        // 2. Теперь мы работаем только с этой константой.
        // Ее значение не может быть изменено извне, в отличие от this.ws.
        currentConnection.on('open', () => {
            console.log(`Connected to Hyperliquid WebSocket for ${symbol}.`);
            const subscriptionMessage = {
                method: 'subscribe',
                subscription: {
                    type: 'l2Book',
                    coin: symbol.toUpperCase()
                },
            };
            // Работаем с константой, а не с this.ws
            currentConnection.send(JSON.stringify(subscriptionMessage));
            console.log('Subscription message sent:', JSON.stringify(subscriptionMessage));
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.channel === 'l2Book' && message.data) {
                    const bookData = message.data;
                    if (bookData.levels && bookData.levels.length === 2) {
                        const bestBid = bookData.levels[0][0].px;
                        const bestAsk = bookData.levels[1][0].px;
                        callback(bestBid, bestAsk);
                    }
                }
            } catch (error) {
                console.error('Error parsing Hyperliquid message:', error);
            }
        });

        currentConnection.on('close', () => {
            console.log('Hyperliquid WebSocket disconnected.');
            // Важно: мы все еще обнуляем свойство класса
            this.ws = null;
        });

        currentConnection.on('error', (error) => {
            console.error('Hyperliquid WebSocket error:', error);
            // И здесь тоже
            this.ws = null;
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Hyperliquid WebSocket...');
            this.ws.close();
            this.ws = null;
        } else {
            console.warn('Attempted to stop a non-existent Hyperliquid WebSocket connection.');
        }
    }
}