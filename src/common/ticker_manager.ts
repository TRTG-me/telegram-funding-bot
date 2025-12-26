import { Logger } from '@nestjs/common';
import { BinanceTickerService } from '../modules/binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../modules/hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../modules/paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../modules/extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../modules/lighter/websocket/lighter.ticker.service';

type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Lighter' | 'Extended';

type PriceCallback = (bid: string, ask: string) => void;

interface Subscription {
    userId: number;
    context: string; // 'trade', 'bp', 'alert', etc.
    callback: PriceCallback;
}

interface TickerNode {
    service: any;
    subscriptions: Subscription[];
}

/**
 * 🚀 TICKER MANAGER (SINGLETON)
 */
export class TickerManager {
    private static instance: TickerManager;
    private readonly logger = new Logger(TickerManager.name);

    private nodes = new Map<string, TickerNode>();

    private constructor() { }

    public static getInstance(): TickerManager {
        if (!TickerManager.instance) {
            TickerManager.instance = new TickerManager();
        }
        return TickerManager.instance;
    }

    private createService(exchange: ExchangeName) {
        switch (exchange) {
            case 'Binance': return new BinanceTickerService();
            case 'Hyperliquid': return new HyperliquidTickerService();
            case 'Paradex': return new ParadexTickerService();
            case 'Extended': return new ExtendedTickerService();
            case 'Lighter': return new LighterTickerService();
            default: throw new Error(`Unknown exchange: ${exchange}`);
        }
    }

    public async subscribe(
        userId: number,
        context: string,
        exchange: ExchangeName,
        symbol: string,
        callback: PriceCallback
    ): Promise<void> {
        const key = `${exchange}_${symbol}`;
        let node = this.nodes.get(key);

        if (!node) {
            this.logger.log(`[TickerManager] Opening NEW socket for ${key}`);
            const service = this.createService(exchange);
            node = { service, subscriptions: [] };
            this.nodes.set(key, node);

            await service.start(symbol, (bid: string, ask: string) => {
                const currentNode = this.nodes.get(key);
                if (currentNode) {
                    currentNode.subscriptions.forEach(sub => sub.callback(bid, ask));
                }
            });
        }

        // Удаляем старую подписку этого пользователя в ЭТОМ контексте
        node.subscriptions = node.subscriptions.filter(s => !(s.userId === userId && s.context === context));
        node.subscriptions.push({ userId, context, callback });

        this.logger.log(`[TickerManager] User ${userId} subscribed to ${key} [Context: ${context}]. Total subs: ${node.subscriptions.length}`);
    }

    public unsubscribe(userId: number, context: string, exchange: ExchangeName, symbol: string): void {
        const key = `${exchange}_${symbol}`;
        const node = this.nodes.get(key);

        if (!node) return;

        // Удаляем подписку конкретного юзера в конкретном контексте
        const oldLen = node.subscriptions.length;
        node.subscriptions = node.subscriptions.filter(s => !(s.userId === userId && s.context === context));

        if (node.subscriptions.length !== oldLen) {
            this.logger.log(`[TickerManager] User ${userId} unsubscribed from ${key} [Context: ${context}]. Remaining: ${node.subscriptions.length}`);
        }

        if (node.subscriptions.length === 0) {
            this.logger.log(`[TickerManager] Closing socket for ${key} (No more subscribers)`);
            node.service.stop();
            this.nodes.delete(key);
        }
    }

    public unsubscribeAll(userId: number): void {
        for (const [key, node] of this.nodes.entries()) {
            const hasSub = node.subscriptions.some(s => s.userId === userId);
            if (hasSub) {
                const [exchange, symbol] = key.split('_');
                // Удаляем ВСЕ контексты этого юзера для этого ключа
                node.subscriptions = node.subscriptions.filter(s => s.userId !== userId);
                this.logger.log(`[TickerManager] User ${userId} fully removed from ${key}. Remaining: ${node.subscriptions.length}`);

                if (node.subscriptions.length === 0) {
                    node.service.stop();
                    this.nodes.delete(key);
                }
            }
        }
    }
}

export const tickerManager = TickerManager.getInstance();
