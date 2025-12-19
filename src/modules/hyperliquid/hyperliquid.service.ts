import axios from 'axios';
import {
    IExchangeData,
    IDetailedPosition,
    IHyperliquidAccountInfo,
    ICombinedAssetCtxHyper,
    IAssetNameInfoHyper,
    IAssetDataContextHyper
} from '../../common/interfaces';

// Используем require для SDK, если нет типов
const { Hyperliquid } = require('hyperliquid');

type MetaAndAssetCtxsResponse = [{ universe: IAssetNameInfoHyper[] }, IAssetDataContextHyper[]];

// Константа таймаута для HTTP запросов
const HTTP_TIMEOUT = 10000;

export class HyperliquidService {
    // Конфигурация, которая будет задана в конструкторе
    private readonly API_URL: string;
    private readonly isTestnet: boolean;

    // Адреса и ключи
    private readonly userAddress: string;
    private readonly userAddress_main: string;
    private readonly privateKey: string;

    // Константы
    private readonly SECONDARY_DEX_ID = 'xyz';

    // SDK
    private sdk: any = null;
    private sdkInitialized = false;

    constructor() {
        // 1. Определяем режим работы
        this.isTestnet = process.env.TESTNET === 'true';

        // 2. Настраиваем переменные в зависимости от режима
        if (this.isTestnet) {
            console.log('🟡 [Hyperliquid] Initializing in TESTNET mode');
            this.API_URL = 'https://api.hyperliquid-testnet.xyz/info';

            this.userAddress = process.env.HL_WALLET_ADDRESS_TEST || '';
            this.privateKey = process.env.HL_PRIVATE_KEY_TEST || '';
            this.userAddress_main = process.env.HL_ACCOUNT_ETH_TEST || '';
        } else {
            console.log('🟢 [Hyperliquid] Initializing in MAINNET mode');
            this.API_URL = 'https://api.hyperliquid.xyz/info';

            this.userAddress = process.env.HL_WALLET_ADDRESS || '';
            this.privateKey = process.env.HL_PRIVATE_KEY || '';
            this.userAddress_main = process.env.HL_ACCOUNT_ETH || '';
        }

        // 3. Валидация
        if (!this.userAddress) {
            throw new Error(`Hyperliquid Wallet Address is missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'} mode.`);
        }

        // 4. Инициализация SDK
        if (this.privateKey) {
            this.sdk = new Hyperliquid({
                enableWs: false,
                privateKey: this.privateKey,
                testnet: this.isTestnet,
                walletAddress: this.userAddress,
            });
            this.initSdk().catch(err => console.error('Failed to init Hyperliquid SDK:', err));
        } else {
            console.warn('[Hyperliquid] Private Key missing. Trading functions will not work.');
        }
    }

    // --- SDK Helpers ---

    private async initSdk() {
        if (!this.sdk || this.sdkInitialized) return;
        try {
            await this.sdk.initialize();
            this.sdkInitialized = true;

        } catch (e) {
            console.error('[Hyperliquid] SDK Initialization error:', e);
        }
    }

    private async ensureSdkReady() {
        if (!this.sdk) throw new Error('Hyperliquid Private Key is not set.');
        if (!this.sdkInitialized) await this.initSdk();
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            return 'Network Timeout';
        }
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    // --- Info API Methods (Axios) ---

    private async getAccountState(dex?: string): Promise<IHyperliquidAccountInfo> {
        try {
            const body: any = {
                type: 'clearinghouseState',
                user: this.userAddress_main,
            };
            if (dex) {
                body.dex = dex;
            }

            // Добавил таймаут
            const response = await axios.post(this.API_URL, body, { timeout: HTTP_TIMEOUT });
            return response.data || {};
        } catch (error) {
            if (dex) {
                console.warn(`Failed to fetch Secondary State (dex: ${dex}):`, this.getErrorMessage(error));
                return {} as IHyperliquidAccountInfo;
            }
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid account state: ${message}`);
        }
    }

    private async fetchContextsForDex(dex?: string): Promise<ICombinedAssetCtxHyper[]> {
        try {
            const body: any = { type: 'metaAndAssetCtxs' };
            if (dex) body.dex = dex;

            // Добавил таймаут
            const response = await axios.post<MetaAndAssetCtxsResponse>(this.API_URL, body, { timeout: HTTP_TIMEOUT });
            const [meta, contexts] = response.data;

            if (!meta?.universe || !contexts) return [];
            if (meta.universe.length !== contexts.length) {
                console.warn(`[Hyperliquid] Universe/Contexts mismatch for dex: ${dex || 'main'}`);
                return [];
            }

            return meta.universe.map((asset, i) => ({
                name: asset.name,
                funding: contexts[i].funding,
            }));
        } catch (error) {
            if (dex) {
                console.warn(`Failed to fetch contexts for dex '${dex}':`, this.getErrorMessage(error));
                return [];
            }
            throw new Error(`Failed to fetch Hyperliquid asset contexts: ${this.getErrorMessage(error)}`);
        }
    }

    private async getAssetContexts(): Promise<ICombinedAssetCtxHyper[] | null> {
        try {
            const [mainContexts, secondaryContexts] = await Promise.all([
                this.fetchContextsForDex(),
                this.fetchContextsForDex(this.SECONDARY_DEX_ID)
            ]);
            return [...mainContexts, ...secondaryContexts];
        } catch (error) {
            throw error;
        }
    }

    private async _getCoreAccountData(): Promise<{
        mainState: IHyperliquidAccountInfo,
        secondaryState: IHyperliquidAccountInfo,
        assetContexts: ICombinedAssetCtxHyper[]
    }> {
        const [mainState, secondaryState, assetContexts] = await Promise.all([
            this.getAccountState(),
            this.getAccountState(this.SECONDARY_DEX_ID),
            this.getAssetContexts()
        ]);

        if (!assetContexts) {
            throw new Error('Incomplete or invalid data received from Hyperliquid API.');
        }

        return { mainState, secondaryState, assetContexts };
    }

    // --- Public Data Methods ---

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const { mainState, secondaryState, assetContexts } = await this._getCoreAccountData();

            const fundingMap = new Map<string, string>(
                assetContexts.map(asset => [asset.name, asset.funding])
            );

            const mapPositions = (positions: any[], exchangeLabel: string): IDetailedPosition[] => {
                if (!Array.isArray(positions)) return [];
                return positions
                    .filter(p => p.position?.szi && parseFloat(p.position.szi) !== 0)
                    .map(p => {
                        const position = p.position;
                        const coin = position.coin!;
                        const szi = parseFloat(position.szi!);
                        const notional = position.positionValue!;
                        const hourlyFundingRate = parseFloat(fundingMap.get(coin) || '0');
                        const fundingRate = hourlyFundingRate * 8 * 100;
                        const entryPx = parseFloat(position.entryPx || '0');

                        return {
                            coin: coin,
                            notional: notional,
                            size: Math.abs(szi),
                            side: szi > 0 ? 'L' : 'S',
                            exchange: exchangeLabel,
                            fundingRate: fundingRate,
                            entryPrice: entryPx,
                        };
                    });
            };

            const listA = mapPositions(mainState.assetPositions || [], 'H');
            const listB = mapPositions(secondaryState.assetPositions || [], 'H');

            return [...listA, ...listB];

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Hyperliquid detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Hyperliquid: ${message}`);
        }
    }

    public async getOpenPosition(symbol: string): Promise<IDetailedPosition | undefined> {
        const cleanSymbol = symbol.replace('-PERP', '');
        const allPositions = await this.getDetailedPositions();
        return allPositions.find(p => p.coin === cleanSymbol);
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const { mainState, secondaryState } = await this._getCoreAccountData();

            const extractData = (state: IHyperliquidAccountInfo) => {
                if (!state.marginSummary) return { val: 0, ntl: 0, maint: 0 };
                return {
                    val: parseFloat(state.marginSummary.accountValue || '0'),
                    ntl: parseFloat(state.marginSummary.totalNtlPos || '0'),
                    maint: parseFloat(state.crossMaintenanceMarginUsed || '0')
                };
            };

            const main = extractData(mainState);
            const sec = extractData(secondaryState);

            const totalAccountValue = main.val + sec.val;
            const totalNotional = main.ntl + sec.ntl;
            const totalMaintUsed = main.maint + sec.maint;
            const P_MM_keff = totalNotional ? (totalMaintUsed / totalNotional) : 0;

            const denominator = totalAccountValue - totalMaintUsed;
            let leverage = 0;

            if (denominator !== 0) {
                leverage = totalNotional / denominator;
            }

            if (totalAccountValue === 0 && totalNotional === 0 && main.val !== 0) {
                return { leverage: main.ntl / (main.val - main.maint), accountEquity: main.val, P_MM_keff };
            }

            return {
                leverage,
                accountEquity: totalAccountValue,
                P_MM_keff,
            };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Hyperliquid leverage calculation:', err);
            throw new Error(`Failed to calculate Hyperliquid leverage: ${message}`);
        }
    }

    // --- Trading Methods (SDK) ---

    public async placeMarketOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number
    ): Promise<any> {
        try {
            await this.ensureSdkReady();
            console.log(`[Hyperliquid] Placing MARKET order: ${side} ${quantity} ${symbol}`);

            const isBuy = side === 'BUY';
            // В SDK таймауты зашиты внутри библиотеки, 
            // но сама инициализация ордера работает через WebSocket/Signing, там HTTP таймаут не поможет.
            // Однако, мы защитили основные методы сбора данных (getAccountState), 
            // что предотвращает зависание мониторинга.
            const result = await this.sdk.custom.marketOpen(symbol, isBuy, quantity);

            const statuses = result.response?.data?.statuses;
            if (!statuses || statuses.length === 0) {
                throw new Error(`Unknown response structure: ${JSON.stringify(result)}`);
            }

            const statusInfo = statuses[0];
            if (statusInfo.error) {
                throw new Error(`Hyperliquid returned error: ${statusInfo.error}`);
            }

            const filledData = statusInfo.filled;
            const restingData = statusInfo.resting;

            const oid = filledData?.oid || restingData?.oid;
            const avgPrice = filledData?.avgPx || restingData?.limitPx || '0';
            const executedQty = filledData?.totalSz || restingData?.sz || quantity;

            const responseData = {
                symbol: symbol,
                orderId: oid,
                side: side,
                status: filledData ? 'FILLED' : 'NEW',
                avgPrice: parseFloat(avgPrice),
                executedQty: parseFloat(executedQty),
                originalResponse: statusInfo
            };

            return responseData;

        } catch (err) {
            console.error('Error placing Hyperliquid order:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Hyperliquid: ${message}`);
        }
    }
    // --- Оптимизированный метод для Auto-Close ---
    // Не запрашивает MetaAndAssetCtxs (фандинги), экономит время и лимиты.
    public async getSimplePositions(): Promise<IDetailedPosition[]> {
        try {
            // Запрашиваем только стейт аккаунта (Main + Secondary)
            // Это 2 параллельных запроса вместо 3 тяжелых
            const [mainState, secondaryState] = await Promise.all([
                this.getAccountState(),
                this.getAccountState(this.SECONDARY_DEX_ID)
            ]);

            const mapPositions = (positions: any[], exchangeLabel: string): IDetailedPosition[] => {
                if (!Array.isArray(positions)) return [];
                return positions
                    .filter(p => p.position?.szi && parseFloat(p.position.szi) !== 0)
                    .map(p => {
                        const position = p.position;
                        const szi = parseFloat(position.szi!);
                        const upnl = parseFloat(position.unrealizedPnl || '0');
                        const val = parseFloat(position.positionValue || '0');

                        return {
                            coin: position.coin!, // API возвращает имя монеты (ETH, BTC)
                            notional: val.toString(),        // Для авто-закрытия не критично
                            size: Math.abs(szi),
                            side: szi > 0 ? 'L' : 'S',
                            exchange: exchangeLabel,
                            fundingRate: 0,       // Экономим время
                            entryPrice: 0,
                            unrealizedPnl: Math.abs(upnl)
                        };
                    });
            };

            const listA = mapPositions(mainState.assetPositions || [], 'H');
            const listB = mapPositions(secondaryState.assetPositions || [], 'H');

            return [...listA, ...listB];

        } catch (err) {
            console.error('[Hyperliquid] Simple positions error:', err);
            return [];
        }
    }
}