import WebSocket from 'ws';
import axios from 'axios';

type PriceUpdateCallback = (bid: string, ask: string) => void;

interface OrderLevel {
    price: string;
    size: string;
}

export class ParadexTickerService {
    private ws: WebSocket | null = null;
    private subscriptionId: number = 1;

    // Храним активный символ для защиты от гонки данных при переключении
    private activeSymbol: string | null = null;

    // Заголовки как у браузера (обязательно для RPI канала)
    private readonly headers = {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        'Origin': 'https://app.paradex.trade'
    };

    constructor() { }

    /**
     * 1. Получает информацию о рынке через REST API.
     * 2. Извлекает price_tick_size (например "0.01").
     * 3. Форматирует для вебсокета ("0_01").
     */
    private async getFormattedTickSize(symbol: string): Promise<string> {
        try {
            const url = `https://api.prod.paradex.trade/v1/markets?market=${symbol}`;
            const res = await axios.get(url, { headers: this.headers });

            if (res.data && res.data.results && res.data.results.length > 0) {
                const tickSize = res.data.results[0].price_tick_size; // "0.01"
                if (tickSize) {
                    // Заменяем точку на нижнее подчеркивание
                    return tickSize.toString().replace('.', '_');
                }
            }
            throw new Error('Tick size not found');
        } catch (e: any) {
            console.warn(`[ParadexTicker] Failed to get tick size for ${symbol}, using default 0_01. Error: ${e.message}`);
            return '0_01'; // Безопасный фоллбэк
        }
    }

    public async start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // 1. Управление соединением
        if (this.ws) {
            if (this.activeSymbol === symbol && this.ws.readyState === WebSocket.OPEN) {
                console.log(`Paradex WebSocket already active for ${symbol}.`);
                return;
            }
            console.log(`Switching Paradex ticker to ${symbol}...`);
            this.stop();
        }

        this.activeSymbol = symbol;

        // 2. Получаем правильный шаг цены для формирования канала
        const tickSizeStr = await this.getFormattedTickSize(symbol);

        // Формируем точное имя канала RPI
        // Пример: order_book.ETH-USD-PERP.interactive@15@100ms@0_01
        const channelName = `order_book.${symbol}.interactive@15@100ms@${tickSizeStr}`;

        console.log(`[ParadexTicker] Connecting to RPI channel: ${channelName}`);

        return new Promise((resolve, reject) => {
            const connectionUrl = 'wss://ws.api.prod.paradex.trade/v1?cancel-on-disconnect=false';

            this.ws = new WebSocket(connectionUrl, { headers: this.headers });
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                // Защита от смены монеты во время коннекта
                if (this.activeSymbol !== symbol) {
                    currentConnection.close();
                    return;
                }

                console.log(`Connected to Paradex WS.`);

                const subscriptionMessage = {
                    jsonrpc: "2.0",
                    method: "subscribe",
                    params: { channel: channelName },
                    id: this.subscriptionId++
                };
                currentConnection.send(JSON.stringify(subscriptionMessage));

                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Paradex WebSocket error:', error);
                this.ws = null;
                this.activeSymbol = null;
                reject(error);
            });

            currentConnection.on('close', (code) => {
                console.log(`Paradex WS disconnected: ${code}`);
                if (this.ws === currentConnection) {
                    this.ws = null;
                    this.activeSymbol = null;
                }
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                // Фильтрация чужих сообщений (если успели переключиться)
                if (this.activeSymbol !== symbol) return;

                try {
                    const message = JSON.parse(data.toString());

                    // Проверяем, что это сообщение с данными
                    if (message.method === 'subscription' && message.params && message.params.data) {
                        const payload = message.params.data;

                        // RPI канал присылает inserts (массив ордеров)
                        // Нам нужно найти лучший Bid (макс цена) и лучший Ask (мин цена) внутри этого пакета

                        if (payload.inserts && Array.isArray(payload.inserts)) {
                            let bestBid = 0;
                            let bestAsk = Infinity;

                            for (const order of payload.inserts) {
                                const price = parseFloat(order.price);

                                if (order.side === 'BUY') {
                                    if (price > bestBid) bestBid = price;
                                } else if (order.side === 'SELL') {
                                    if (price < bestAsk) bestAsk = price;
                                }
                            }

                            // Если нашли цены, отправляем в колбэк
                            if (bestBid > 0 && bestAsk !== Infinity) {
                                callback(bestBid.toString(), bestAsk.toString());
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Paradex message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Paradex WebSocket...');
            this.ws.removeAllListeners();
            this.ws.close(1000);
            this.ws = null;
            this.activeSymbol = null;
        }
    }
}