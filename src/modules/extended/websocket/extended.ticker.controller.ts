import { Context } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { ExtendedTickerService } from './extended.ticker.service';

interface ActiveTickerInfo {
    messageId: number;
    lastMessageText: string;
    lastUpdateTime: number;
}

export class ExtendedTickerController {
    private activeTickers = new Map<number, ActiveTickerInfo>();

    constructor(private readonly tickerService: ExtendedTickerService) { }

    public async startTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const symbol = 'BTC-USD'; // Формат символа для Extended Exchange

        if (this.activeTickers.has(chatId)) {
            await ctx.reply('Тикер Extended Exchange уже запущен в этом чате.');
            return;
        }

        const initialMessage = await ctx.reply(`⏳ Запускаю тикер Extended Exchange для ${symbol}...`);

        this.activeTickers.set(chatId, {
            messageId: initialMessage.message_id,
            lastMessageText: '',
            lastUpdateTime: 0,
        });

        const onPriceUpdate = async (bid: string, ask: string) => {
            const tickerInfo = this.activeTickers.get(chatId);
            if (!tickerInfo) return;

            const now = Date.now();
            const timeSinceLastUpdate = now - tickerInfo.lastUpdateTime;
            const THROTTLE_INTERVAL_MS = 500; // Задержка 500 мс

            if (timeSinceLastUpdate < THROTTLE_INTERVAL_MS) {
                return;
            }

            const escapedSymbol = symbol.replace(/([-_\[\]()~`>#\+\=\|{}\.!\\])/g, '\\$1');
            const newText = `*Extended ${escapedSymbol}*\n\n🟢 Bid \\(покупка\\): \`${bid}\`\n🔴 Ask \\(продажа\\): \`${ask}\``;

            if (newText === tickerInfo.lastMessageText) {
                return;
            }

            tickerInfo.lastMessageText = newText;
            tickerInfo.lastUpdateTime = now;

            try {
                await ctx.telegram.editMessageText(
                    chatId,
                    tickerInfo.messageId,
                    undefined,
                    newText,
                    { parse_mode: 'MarkdownV2' }
                );
            } catch (error: any) {
                if (error.description !== 'Bad Request: message is not modified') {
                    console.error('Failed to edit Extended message:', error);
                }
            }
        };

        this.tickerService.start(symbol, onPriceUpdate);
    }

    public async stopTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const tickerInfo = this.activeTickers.get(chatId);

        if (!tickerInfo) {
            await ctx.reply('Тикер Extended Exchange не был запущен.');
            return;
        }

        this.tickerService.stop();

        try {
            await ctx.telegram.editMessageText(
                chatId,
                tickerInfo.messageId,
                undefined,
                '✅ Тикер Extended Exchange остановлен.'
            );
        } catch (error) {
            console.error('Failed to edit Extended stop message:', error);
        }

        this.activeTickers.delete(chatId);
    }
}