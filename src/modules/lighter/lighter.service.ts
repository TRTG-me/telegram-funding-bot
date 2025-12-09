import axios from 'axios';
import { Injectable } from '@nestjs/common'; // Если используете NestJS DI
import { LighterClient, ORDER_TYPE } from './lighter.client';
import { IExchangeData, IDetailedPosition, ILighterApiResponse, IFundingRatesResponseLighter } from '../../common/interfaces';

@Injectable()
export class LighterService {
    private readonly isTestnet: boolean;
    private readonly API_URL: string;
    private readonly l1Address: string;

    // Переменные для инициализации клиента
    private readonly privateKey: string;
    private readonly apiKeyIndex: number;
    private readonly accountIndex: string | number;

    private tradeClient: LighterClient;

    constructor() {
        // 1. Определяем режим работы
        this.isTestnet = process.env.TESTNET === 'true';

        // 2. Настраиваем переменные в зависимости от режима
        if (this.isTestnet) {
            console.log('🟡 [Lighter] Initializing in TESTNET mode');
            this.API_URL = 'https://testnet.zklighter.elliot.ai/api/v1';

            // Тестовые ключи из .env
            this.l1Address = process.env.LIGHTER_L1_ADDRESS_TEST || '';
            this.privateKey = process.env.LIGHTER_API_KEY_PRIVATE_KEY_TEST || '';
            this.apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX_TEST || 0);
            this.accountIndex = process.env.LIGHTER_ACCOUNT_INDEX_TEST || 0;
        } else {
            console.log('🟢 [Lighter] Initializing in MAINNET mode');
            this.API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';

            // Боевые ключи из .env
            this.l1Address = process.env.LIGHTER_L1_ADDRESS || '';
            this.privateKey = process.env.LIGHTER_API_KEY_PRIVATE_KEY || '';
            this.apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX || 0);
            this.accountIndex = process.env.LIGHTER_ACCOUNT_INDEX || 0;
        }

        // 3. Валидация обязательных полей
        if (!this.l1Address) {
            throw new Error(`Lighter L1 Address is missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'} mode.`);
        }
        if (!this.privateKey) {
            console.warn(`⚠️ [Lighter] Private Key missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'}. Trading functions will not work.`);
        }

        // 4. Инициализация торгового клиента
        this.tradeClient = new LighterClient({
            // Удаляем /api/v1, так как клиент сам добавляет пути, или используем как base
            // В нашем Client коде мы добавляли /api/v1 вручную, поэтому передаем чистый хост
            baseUrl: this.API_URL.replace('/api/v1', ''),
            privateKey: this.privateKey,
            apiKeyIndex: this.apiKeyIndex,
            accountIndex: this.accountIndex,
            // 300 для тестнета Arbitrum Sepolia, для мейнета обычно подхватывается дефолт или 1/42161
            chainId: this.isTestnet ? 300 : undefined
        });

        this.tradeClient.init().catch(e => console.error('Lighter Client Init Error:', e));
    }
    public async checkSymbolExists(coin: string): Promise<boolean> {
        // Убеждаемся, что клиент инициализирован и рынки загружены
        if (!this.tradeClient.isInitialized) {
            await this.tradeClient.init();
        }

        const marketId = this.tradeClient.getMarketId(coin);
        return marketId !== null;
    }
    public getMarketId(symbol: string): number | null {
        // Вызываем метод клиента, который у тебя уже есть
        return this.tradeClient.getMarketId(symbol);
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private async getAccountData(): Promise<ILighterApiResponse> {
        try {
            const url = `${this.API_URL}/account?by=l1_address&value=${this.l1Address}`;
            const response = await axios.get<ILighterApiResponse>(url, {
                headers: { 'accept': 'application/json' }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Lighter account data: ${this.getErrorMessage(error)}`);
        }
    }

    // --- НОВАЯ ФУНКЦИЯ ---
    /**
     * Получает и форматирует информацию об открытых позициях в унифицированный вид.
     * @returns Промис, который разрешается массивом детализированных позиций.
     */
    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Параллельно запрашиваем данные аккаунта и ставки фандинга ---
            const [accountResponse, fundingResponse] = await Promise.all([
                this.getAccountData(),
                axios.get<IFundingRatesResponseLighter>(`${this.API_URL}/funding-rates`)
            ]);

            // --- Шаг 2: Проверяем наличие и структуру данных ---
            const account = accountResponse?.accounts?.[0];
            const fundingRates = fundingResponse?.data?.funding_rates;

            if (!account || !Array.isArray(account.positions) || !Array.isArray(fundingRates)) {
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            // --- Шаг 3: Создаем карту для быстрого доступа к ставкам фандинга ---
            const fundingMap = new Map<string, number>();
            fundingRates
                .filter(rate => rate.exchange === 'lighter') // Оставляем только фандинг от самой биржи Lighter
                .forEach(rate => {
                    fundingMap.set(rate.symbol, rate.rate);
                });

            // --- Шаг 4: Фильтруем и преобразуем открытые позиции ---
            const detailedPositions: IDetailedPosition[] = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0) // Оставляем только открытые
                .map(position => {
                    const coin = position.symbol!;
                    // API отдает ставку уже в виде готового числа, умножаем на 100 для получения процентов
                    const fundingRate = (fundingMap.get(coin) || 0) * 100;

                    return {
                        coin: coin,
                        notional: Math.abs(parseFloat(position.position_value || '0')).toString(),
                        size: Math.abs(parseFloat(position.position || '0')),
                        side: position.sign === 1 ? 'L' : 'S',
                        exchange: 'L', // 'L' для Lighter
                        fundingRate: fundingRate,
                    };
                });

            return detailedPositions;

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Lighter detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Lighter: ${message}`);
        }
    }


    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountData();

            const account = response?.accounts?.[0];
            if (!account || typeof account.total_asset_value !== 'string' || typeof account.available_balance !== 'string' || !Array.isArray(account.positions)) {
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            const totalAssetValue = parseFloat(account.total_asset_value);
            const availableBalance = parseFloat(account.available_balance);

            if (isNaN(totalAssetValue) || isNaN(availableBalance)) {
                throw new Error('Failed to parse financial data from Lighter API response.');
            }

            const totalPositionValue = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0)
                .reduce((sum, p) => sum + Math.abs(parseFloat(p.position_value || '0')), 0);

            if (totalPositionValue === 0) {
                return { leverage: 0, accountEquity: totalAssetValue };
            }

            const maintenanceMargin = (totalAssetValue - availableBalance) * 0.6;
            const denominator = totalAssetValue - maintenanceMargin;

            if (denominator <= 0) {
                throw new Error('Cannot calculate leverage: Invalid denominator.');
            }

            const leverage = totalPositionValue / denominator;
            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return { leverage, accountEquity: totalAssetValue };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Lighter leverage calculation:', err);
            throw new Error(`Failed to calculate Lighter leverage: ${message}`);
        }
    }
    public async placeOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        amount: number,
        type: 'LIMIT' | 'MARKET' = 'LIMIT',
        price?: number
    ) {
        // 1. АВТОМАТИЧЕСКИЙ ПОИСК MARKET ID
        // Мы передаем название монеты (напр. "ADA" или "ZK")
        const marketId = this.tradeClient.getMarketId(symbol);

        if (marketId === null) {
            throw new Error(`Symbol '${symbol}' not found on Lighter exchange!`);
        }

        console.log(`[Lighter] Found Market ID for ${symbol}: ${marketId}`);

        const isAsk = side === 'SELL';
        const orderType = type === 'MARKET' ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT;

        // 2. Отправляем ордер с найденным ID
        const result = await this.tradeClient.placeOrder({
            marketId,
            isAsk,
            orderType,
            amount,
            price,
            slippage: 0.05
        });

        console.log(`✅ [Lighter] Order SENT. TxHash: ${result.txHash}`);

        // 3. Polling
        const fallbackPrice = price || 0;
        const fillDetails = await this.pollTransactionDetails(
            result.txHash,
            marketId,
            amount,
            fallbackPrice
        );

        return {
            success: true,
            orderId: result.sentNonce,
            txHash: result.txHash,
            ...fillDetails
        };
    }

    // --- ЛОГИКА ОБРАБОТКИ ОТВЕТА API ---
    private async pollTransactionDetails(txHash: string, marketId: number, fallbackQty: number, fallbackPrice: number) {
        const maxAttempts = 20;

        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, 1000));

            const txData = await this.tradeClient.getTransactionByHash(txHash);

            // Если транзакция найдена (API вернуло 200 и данные)
            if (txData && txData.event_info) {
                console.log(`✅ [Lighter] Transaction confirmed on attempt ${i + 1}!`);

                try {
                    const eventInfo = JSON.parse(txData.event_info);
                    const trade = eventInfo.t;

                    // ВАРИАНТ А: СДЕЛКА ПРОШЛА (FILLED)
                    if (trade && parseFloat(trade.s) > 0) {
                        const market = this.tradeClient.markets[marketId];
                        const sizeMult = 10 ** market.sizeDecimals;
                        const priceMult = 10 ** market.priceDecimals;

                        const rawPrice = parseFloat(trade.p);
                        const rawSize = parseFloat(trade.s);

                        const realAvgPrice = rawPrice / priceMult;
                        const realFilledQty = rawSize / sizeMult;

                        const isFullyFilled = (eventInfo.to && eventInfo.to.rs === 0);
                        const status = isFullyFilled ? 'FILLED' : 'PARTIALLY_FILLED';

                        console.log(`📊 Executed: ${realFilledQty} @ ${realAvgPrice}`);

                        return {
                            avgPrice: realAvgPrice,
                            filledQty: realFilledQty,
                            status: status
                        };
                    }

                    // ВАРИАНТ Б: СДЕЛКИ НЕТ, НО ТРАНЗАКЦИЯ УСПЕШНА (OPEN / MAKER)
                    // Это значит, ордер встал в стакан.
                    else {
                        console.log(`🕒 [Lighter] Order placed in book (Maker). No fill yet.`);
                        return {
                            avgPrice: fallbackPrice, // Возвращаем лимитную цену
                            filledQty: fallbackQty,  // Возвращаем объем ордера
                            status: 'OPEN'           // Новый статус
                        };
                    }

                } catch (e) {
                    console.warn('[Lighter] JSON parse error:', e);
                }
            }
            // Если txData нет (404), цикл продолжается...
        }

        console.log(`\n⚠️ [Lighter] Tx polling timeout. Assuming success.`);

        return {
            avgPrice: fallbackPrice,
            filledQty: fallbackQty,
            status: 'ASSUMED_FILLED'
        };
    }
}
