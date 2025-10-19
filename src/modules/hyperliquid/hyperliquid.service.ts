import axios from 'axios';

// Тип для метаданных по одному активу (из первого массива 'universe')
interface AssetNameInfo {
    name: string;
}

// Тип для контекстных данных по одному активу
interface AssetDataContext {
    funding: string;
}

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: AssetNameInfo[] }, AssetDataContext[]];

// Тип для "склеенных" данных по одному активу
interface CombinedAssetCtx {
    name: string;
    funding: string;
}

// Тип для ответа API 'clearinghouseState'
interface HyperliquidAccountInfo {
    marginSummary?: {
        accountValue?: string;
        totalNtlPos?: string;
    };
    assetPositions?: {
        position: {
            coin?: string;
            szi?: string;
            positionValue?: string;
        }
    }[];
    crossMaintenanceMarginUsed?: string;
}


// Детали одной открытой позиции для отображения
export interface PositionDetail {
    coin: string;
    side: 'Long' | 'Short';
    size: number;
    notionalValue: number;
    fundingRate: number; // Уже в процентах
}

// Полный объект с данными для контроллера (наш главный "продукт")
export interface FullAccountSummary {
    accountValue: number;
    marginUsed: number;
    leverages: {
        byPositionValue: number;
        byTotalNtlPos: number;
    };
    openPositions: PositionDetail[];
}

export class HyperliquidService {
    private readonly API_URL = 'https://api.hyperliquid.xyz/info';


    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private async getAccountState(userAddress: string): Promise<HyperliquidAccountInfo> {
        try {
            const response = await axios.post(this.API_URL, {
                type: 'clearinghouseState',
                user: userAddress,
            });
            return response.data || {};
        } catch (error) {
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid account state: ${message}`);
        }
    }

    private async getAssetContexts(): Promise<CombinedAssetCtx[] | null> {
        try {
            const response = await axios.post<MetaAndAssetCtxsResponse>(this.API_URL, {
                type: 'metaAndAssetCtxs',
            });

            const [meta, contexts] = response.data;
            const universe = meta.universe;

            if (universe.length !== contexts.length) {
                console.error("Universe and contexts arrays have different lengths!");
                return null;
            }

            return universe.map((asset, i) => ({
                name: asset.name,
                funding: contexts[i].funding,
            }));

        } catch (error) {
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid asset contexts: ${message}`);
        }
    }

    // --- ЕДИНЫЙ ПУБЛИЧНЫЙ МЕТОД ---

    public async getAccountSummary(userAddress: string): Promise<FullAccountSummary> {
        try {
            // 1. Получаем все "сырые" данные параллельно
            const [accountState, assetContexts] = await Promise.all([
                this.getAccountState(userAddress),
                this.getAssetContexts()
            ]);

            // 2. "Фейсконтроль" для всех полученных данных
            if (
                !accountState.marginSummary ||
                typeof accountState.marginSummary.accountValue !== 'string' ||
                typeof accountState.marginSummary.totalNtlPos !== 'string' ||
                typeof accountState.crossMaintenanceMarginUsed !== 'string' ||
                !Array.isArray(accountState.assetPositions) ||
                !assetContexts
            ) {
                throw new Error('Incomplete or invalid data received from Hyperliquid API.');
            }

            // 3. Выполняем все вычисления
            const accountValue = parseFloat(accountState.marginSummary.accountValue);
            const marginUsed = parseFloat(accountState.crossMaintenanceMarginUsed);
            const totalNtlPos = parseFloat(accountState.marginSummary.totalNtlPos);

            if (isNaN(accountValue) || isNaN(marginUsed) || isNaN(totalNtlPos)) {
                throw new Error('Failed to parse financial data from API response.');
            }

            const denominator = accountValue - marginUsed;
            let leverages = { byPositionValue: 0, byTotalNtlPos: 0 };

            if (denominator !== 0) {
                const totalPositionValue = accountState.assetPositions.reduce((sum, p) => {
                    return sum + Math.abs(parseFloat(p.position.positionValue || '0'));
                }, 0);

                leverages.byPositionValue = totalPositionValue / denominator;
                leverages.byTotalNtlPos = totalNtlPos / denominator;

                if (!isFinite(leverages.byPositionValue) || !isFinite(leverages.byTotalNtlPos)) {
                    throw new Error('Leverage calculation resulted in a non-finite number.');
                }
            }

            // 4. Обрабатываем и фильтруем позиции
            const universeMap = new Map<string, CombinedAssetCtx>(
                assetContexts.map(asset => [asset.name, asset])
            );

            const openPositions: PositionDetail[] = accountState.assetPositions
                .filter(p => parseFloat(p.position.szi || '0') !== 0)
                .map(p => {
                    const position = p.position;
                    const szi = parseFloat(position.szi || '0');
                    const assetData = universeMap.get(position.coin || '');

                    return {
                        coin: position.coin || 'Unknown',
                        side: szi > 0 ? 'Long' : 'Short',
                        size: szi,
                        notionalValue: Math.abs(parseFloat(position.positionValue || '0')),
                        fundingRate: parseFloat(assetData?.funding || '0') * 100,
                    };
                });

            // 5. Собираем и возвращаем финальный, чистый объект с данными
            return {
                accountValue,
                marginUsed,
                leverages,
                openPositions,
            };

        } catch (err) {
            const message = this.getErrorMessage(err);
            // Логируем для себя полную ошибку
            console.error('Error during Hyperliquid account summary generation:', err);
            // Наружу отдаем более общее сообщение
            throw new Error(`Failed to get Hyperliquid account summary: ${message}`);
        }
    }
}
