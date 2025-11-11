import { Context } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { LighterTickerService } from './lighter.ticker.service';

interface ActiveTickerInfo {
    messageId: number;
    lastMessageText: string;
    lastUpdateTime: number;
}

export class LighterTickerController {
    private activeTickers = new Map<number, ActiveTickerInfo>();

    constructor(private readonly tickerService: LighterTickerService) { }

    public async startTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        // Согласно документации, используется индекс рынка, например "0"
        const marketIndex = '68';
        const displayName = `Lighter Market ${marketIndex}`; // Имя для отображения в сообщении

        if (this.activeTickers.has(chatId)) {
            await ctx.reply(`Тикер ${displayName} уже запущен в этом чате.`);
            return;
        }

        const initialMessage = await ctx.reply(`⏳ Запускаю тикер ${displayName}...`);

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

            const newText = `*${displayName}*\n\n🔴 Ask \\(продажа\\): \`${ask}\`\n🟢 Bid \\(покупка\\): \`${bid}\``;

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
                    console.error('Failed to edit Lighter message:', error);
                }
            }
        };

        this.tickerService.start(marketIndex, onPriceUpdate);
    }

    public async stopTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const tickerInfo = this.activeTickers.get(chatId);

        if (!tickerInfo) {
            await ctx.reply('Тикер Lighter не был запущен.');
            return;
        }

        this.tickerService.stop();

        try {
            await ctx.telegram.editMessageText(
                chatId,
                tickerInfo.messageId,
                undefined,
                '✅ Тикер Lighter остановлен.'
            );
        } catch (error) {
            console.error('Failed to edit Lighter stop message:', error);
        }

        this.activeTickers.delete(chatId);
    }
}