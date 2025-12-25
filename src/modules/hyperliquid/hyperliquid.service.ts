import axios from 'axios';
import {
    IExchangeData,
    IDetailedPosition,
    IHyperliquidAccountInfo,
    ICombinedAssetCtxHyper,
    IAssetNameInfoHyper,
    IAssetDataContextHyper
} from '../../common/interfaces';
import { UserService } from '../users/users.service';

// Используем require для SDK, если нет типов
const { Hyperliquid } = require('hyperliquid');

type MetaAndAssetCtxsResponse = [{ universe: IAssetNameInfoHyper[] }, IAssetDataContextHyper[]];

// Константа таймаута для HTTP запросов
const HTTP_TIMEOUT = 10000;

interface HlContext {
    userAddress: string;
    userAddress_main: string;
    sdk?: any;
    sdkInitialized: boolean;
}

export class HyperliquidService {
    // Конфигурация
    private readonly API_URL: string;
    private readonly isTestnet: boolean;
    private readonly SECONDARY_DEX_ID = 'xyz';

    // Дефолтный контекст (из .env)
    private defaultContext: HlContext;
    // Кеш контекстов юзеров
    private userContexts = new Map<number, HlContext>();

    constructor(private userService?: UserService) {
        // 1. Определяем режим работы
        this.isTestnet = process.env.TESTNET === 'true';

        // 2. Настраиваем API URL
        if (this.isTestnet) {
            console.log('🟡 [Hyperliquid] Initializing in TESTNET mode');
            this.API_URL = 'https://api.hyperliquid-testnet.xyz/info';
        } else {
            console.log('🟢 [Hyperliquid] Initializing in MAINNET mode');
            this.API_URL = 'https://api.hyperliquid.xyz/info';
        }

        // 3. Создаем дефолтный контекст
        this.defaultContext = this.createContext(
            this.isTestnet ? process.env.HL_WALLET_ADDRESS_TEST : process.env.HL_WALLET_ADDRESS,
            this.isTestnet ? process.env.HL_ACCOUNT_ETH_TEST : process.env.HL_ACCOUNT_ETH,
            this.isTestnet ? process.env.HL_PRIVATE_KEY_TEST : process.env.HL_PRIVATE_KEY
        );

        if (!this.defaultContext.userAddress) {
            // throw new Error не будем, вдруг бот только для других бирж, но варнинг нужен
            console.warn(`[Hyperliquid] Wallet Address missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'} mode.`);
        } else {
            this.initSdk(this.defaultContext).catch(err => console.error('Failed to init Default Hyperliquid SDK:', err));
        }
    }

    private createContext(address?: string, addressMain?: string, privateKey?: string): HlContext {
        const ctx: HlContext = {
            userAddress: address || '',
            userAddress_main: addressMain || '',
            sdk: null,
            sdkInitialized: false
        };

        if (privateKey && address) {
            try {
                ctx.sdk = new Hyperliquid({
                    enableWs: false,
                    privateKey: privateKey,
                    testnet: this.isTestnet,
                    walletAddress: address,
                });
            } catch (e) {
                console.error('[Hyperliquid] Failed to create SDK instance:', e);
            }
        }
        return ctx;
    }

    private async getContext(userId?: number): Promise<HlContext> {
        // Если userId не указан - только для системных операций
        if (!userId) {
            if (!this.userService) {
                return this.defaultContext;
            }
            throw new Error('[Hyperliquid] userId is required for user operations');
        }

        if (this.userContexts.has(userId)) return this.userContexts.get(userId)!;

        // Проверка наличия UserService
        if (!this.userService) {
            throw new Error('[Hyperliquid] UserService not available');
        }

        // Fetch from DB
        const user = await this.userService.getUser(userId);
        if (!user) {
            throw new Error(`[Hyperliquid] User ${userId} not found in database`);
        }

        const address = (this.isTestnet ? user.hlTestWalletAddress : user.hlWalletAddress) ?? undefined;
        const addressMain = (this.isTestnet ? user.hlTestAccountEth : user.hlAccountEth) ?? undefined;
        const pKey = (this.isTestnet ? user.hlTestPrivateKey : user.hlPrivateKey) ?? undefined;

        // Строгая проверка: ключи ОБЯЗАТЕЛЬНЫ
        if (!address || !pKey) {
            throw new Error(`[Hyperliquid] User ${userId} has no API keys configured. Please add keys to database.`);
        }

        const ctx = this.createContext(address, addressMain, pKey);

        // Init SDK immediately if present
        if (ctx.sdk) {
            this.initSdk(ctx).catch(e => console.error(`Failed to init HL SDK for user ${userId}`, e));
        }

        this.userContexts.set(userId, ctx);
        return ctx;
    }

    // --- SDK Helpers ---

    private async initSdk(ctx: HlContext) {
        if (!ctx.sdk || ctx.sdkInitialized) return;
        try {
            await ctx.sdk.initialize();
            ctx.sdkInitialized = true;
        } catch (e) {
            console.error('[Hyperliquid] SDK Initialization error:', e);
        }
    }

    private async ensureSdkReady(ctx: HlContext) {
        if (!ctx.sdk) throw new Error('Hyperliquid Private Key is not set.');
        if (!ctx.sdkInitialized) await this.initSdk(ctx);
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            return 'Network Timeout';
        }
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    // --- Info API Methods (Axios) ---

    private async getAccountState(dex?: string, userId?: number): Promise<IHyperliquidAccountInfo> {
        try {
            const ctx = await this.getContext(userId);

            // Если адреса нет, смысла запрашивать нет
            if (!ctx.userAddress_main) return {} as IHyperliquidAccountInfo;

            const body: any = {
                type: 'clearinghouseState',
                user: ctx.userAddress_main,
            };
            if (dex) {
                body.dex = dex;
            }

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
        // Контексты активов ОБЩИЕ для всех, от юзера не зависят
        try {
            const body: any = { type: 'metaAndAssetCtxs' };
            if (dex) body.dex = dex;

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

    private async _getCoreAccountData(userId?: number): Promise<{
        mainState: IHyperliquidAccountInfo,
        secondaryState: IHyperliquidAccountInfo,
        assetContexts: ICombinedAssetCtxHyper[]
    }> {
        const [mainState, secondaryState, assetContexts] = await Promise.all([
            this.getAccountState(undefined, userId),
            this.getAccountState(this.SECONDARY_DEX_ID, userId),
            this.getAssetContexts()
        ]);

        if (!assetContexts) {
            throw new Error('Incomplete or invalid data received from Hyperliquid API.');
        }

        return { mainState, secondaryState, assetContexts };
    }

    // --- Public Data Methods ---

    public async getDetailedPositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const { mainState, secondaryState, assetContexts } = await this._getCoreAccountData(userId);

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
            console.error(`Error fetching Hyperliquid detailed positions (User: ${userId}):`, err);
            throw new Error(`Failed to get detailed positions from Hyperliquid: ${message}`);
        }
    }

    public async getOpenPosition(symbol: string, userId?: number): Promise<IDetailedPosition | undefined> {
        const cleanSymbol = symbol.replace('-PERP', '');
        const allPositions = await this.getDetailedPositions(userId);
        return allPositions.find(p => p.coin === cleanSymbol);
    }

    public async calculateLeverage(userId?: number): Promise<IExchangeData> {
        try {
            const { mainState, secondaryState } = await this._getCoreAccountData(userId);

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
            console.error(`Error during Hyperliquid leverage calculation (User: ${userId}):`, err);
            throw new Error(`Failed to calculate Hyperliquid leverage: ${message}`);
        }
    }

    // --- Trading Methods (SDK) ---

    public async placeMarketOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number,
        userId?: number // <-- Added
    ): Promise<any> {
        try {
            const ctx = await this.getContext(userId);
            await this.ensureSdkReady(ctx);
            console.log(`[Hyperliquid] Placing MARKET order: ${side} ${quantity} ${symbol} (User: ${userId || 'env'})`);

            const isBuy = side === 'BUY';
            const result = await ctx.sdk.custom.marketOpen(symbol, isBuy, quantity);

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
            console.error(`Error placing Hyperliquid order (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Hyperliquid: ${message}`);
        }
    }
    // --- Оптимизированный метод для Auto-Close ---
    // Не запрашивает MetaAndAssetCtxs (фандинги), экономит время и лимиты.
    public async getSimplePositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            // Запрашиваем только стейт аккаунта (Main + Secondary)
            const [mainState, secondaryState] = await Promise.all([
                this.getAccountState(undefined, userId),
                this.getAccountState(this.SECONDARY_DEX_ID, userId)
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
                            coin: position.coin!,
                            notional: val.toString(),
                            size: Math.abs(szi),
                            side: szi > 0 ? 'L' : 'S',
                            exchange: exchangeLabel,
                            fundingRate: 0,
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
