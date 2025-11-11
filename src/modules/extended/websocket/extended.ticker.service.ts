import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ExtendedTickerService {
    private ws: WebSocket | null = null;

    constructor() {
        console.log('ExtendedTickerService initialized.');
    }

    public start(symbol: string, callback: PriceUpdateCallback): void {
        if (this.ws) {
            console.warn('Extended Exchange WebSocket connection is already active.');
            return;
        }

        const connectionUrl = `wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks/${symbol.toUpperCase()}?depth=1`;

        // --- ГЛАВНОЕ ИСПРАВЛЕНИЕ ---
        // Создаем опции для подключения, включая заголовок User-Agent,
        // чтобы имитировать подключение из браузера.
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
            }
        };

        console.log(`Attempting to connect to Extended Exchange at: ${connectionUrl}`);
        // Передаем опции вторым аргументом в конструктор WebSocket
        this.ws = new WebSocket(connectionUrl, options);

        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            console.log(`Successfully connected to Extended Exchange WebSocket for ${symbol}. Waiting for data...`);
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.type === 'SNAPSHOT' && message.data) {
                    const priceData = message.data;

                    if (priceData.b && priceData.b.length > 0 && priceData.a && priceData.a.length > 0) {
                        const bestBid = priceData.b[0].p;
                        const bestAsk = priceData.a[0].p;

                        if (bestBid && bestAsk) {
                            callback(bestBid, bestAsk);
                        }
                    }
                }
            } catch (error) {
                console.error('Error parsing Extended Exchange message:', error);
            }
        });

        currentConnection.on('close', (code, reason) => {
            console.log(`Extended Exchange WebSocket disconnected: ${code} - ${reason.toString()}`);
            this.ws = null;
        });

        currentConnection.on('error', (error) => {
            console.error('Extended Exchange WebSocket error:', error);
            this.ws = null;
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Extended Exchange WebSocket...');
            this.ws.close();
            this.ws = null;
        } else {
            console.warn('Attempted to stop a non-existent Extended Exchange WebSocket connection.');
        }
    }
}