// src/modules/hyperliquid/hyperliquid.service.ts

import axios from 'axios';

// --- Типы для данных, которые мы получаем ---

// Тип для метаданных по одному активу (из первого массива 'universe')
interface AssetNameInfo {
    name: string;
}

// ИЗМЕНЕНИЕ: Убираем markPx, т.к. он не нужен
interface AssetDataContext {
    funding: string;
}

// ИЗМЕНЕНИЕ: Убираем markPx из "склеенного" типа
interface CombinedAssetCtx {
    name: string;
    funding: string;
}

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: AssetNameInfo[] }, AssetDataContext[]];

// Тип для данных о позициях пользователя
interface HyperliquidAccountInfo {
    marginSummary: {
        accountValue: string;
    };
    assetPositions: {
        position: {
            coin: string;
            szi: string;
            positionValue: string;
        }
    }[];
    crossMaintenanceMarginUsed: string;
}

export class HyperliquidService {
    private readonly API_URL = 'https://api.hyperliquid.xyz/info';

    private async getAccountState(userAddress: string): Promise<HyperliquidAccountInfo | null> {
        try {
            const response = await axios.post(this.API_URL, {
                type: 'clearinghouseState',
                user: userAddress,
            });
            return response.data;
        } catch (error) {
            console.error('Ошибка при запросе clearinghouseState:', error);
            return null;
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
                console.error("Universe и contexts массивы имеют разную длину!");
                return null;
            }

            const combinedContexts: CombinedAssetCtx[] = [];
            for (let i = 0; i < universe.length; i++) {
                // ИЗМЕНЕНИЕ: Убираем markPx из логики "склеивания"
                combinedContexts.push({
                    name: universe[i].name,
                    funding: contexts[i].funding,
                });
            }

            return combinedContexts;

        } catch (error) {
            console.error('Ошибка при запросе metaAndAssetCtxs:', error);
            return null;
        }
    }

    public async getFormattedAccountInfo(userAddress: string): Promise<string | null> {
        const [accountState, assetContexts] = await Promise.all([
            this.getAccountState(userAddress),
            this.getAssetContexts()
        ]);

        if (!accountState || !assetContexts) {
            return 'Не удалось получить полную информацию об аккаунте. Попробуйте позже.';
        }

        const { marginSummary, assetPositions, crossMaintenanceMarginUsed } = accountState;

        const accountValue = parseFloat(marginSummary.accountValue).toFixed(2);
        const totalMargin = parseFloat(crossMaintenanceMarginUsed).toFixed(2);

        let message = `<b>📊 Ваш аккаунт Hyperliquid</b>\n\n`;
        message += `💰 <b>Общая стоимость:</b> <code>$${accountValue}</code>\n`;
        message += `💼 <b>Margin:</b> <code>$${totalMargin}</code>\n\n`;
        message += `<b>Данные с HyperLiquid</b>\n`;

        const openPositions = assetPositions.filter(p => parseFloat(p.position.szi) !== 0);

        if (openPositions.length === 0) {
            message += "<i>Открытых позиций нет.</i>";
            return message;
        }

        const universeMap = new Map<string, CombinedAssetCtx>(
            assetContexts.map(asset => [asset.name, asset])
        );

        const headers = { coin: 'Монета', size: 'Размер', notional: 'Стоимость', funding: 'Фандинг ' };
        const columnWidths = { coin: 20, size: 20, notional: 20, funding: 15 };

        let table = `${headers.coin.padEnd(columnWidths.coin)}`;
        table += `${headers.size.padEnd(columnWidths.size)}`;
        table += `${headers.notional.padEnd(columnWidths.notional)}`;
        table += `${headers.funding.padEnd(columnWidths.funding)}\n\n`;

        for (const pos of openPositions) {
            const { coin, szi, positionValue } = pos.position;
            const assetData = universeMap.get(coin);

            if (!assetData) continue;

            const sideEmoji = parseFloat(szi) > 0 ? '🟢' : '🔴';
            const coinText = `${sideEmoji} ${coin}`;
            const sizeText = parseFloat(szi).toFixed(4);
            const notionalValue = Math.abs(parseFloat(positionValue));
            const notionalText = `$${notionalValue.toFixed(2)}`;
            const fundingValue = parseFloat(assetData.funding) * 100;
            const fundingText = `${fundingValue.toFixed(4)}%`;

            table += `${coinText.padEnd(columnWidths.coin)}`;
            table += `${sizeText.padEnd(columnWidths.size)}`;
            table += `${notionalText.padEnd(columnWidths.notional)}`;
            table += `${fundingText.padEnd(columnWidths.funding)}\n`;
        }

        message += `<pre>${table}</pre>`;

        return message;
    }
}