// src/modules/lighter/lighter.controller.ts
import { Context } from 'telegraf';
import { LighterService } from './lighter.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

// --- Вставляем наши интерфейсы сюда ---
interface Position {
    symbol: string;
    position: string;
    avg_entry_price: string;
    unrealized_pnl: string;
}
interface Account {
    l1_address: string;
    available_balance: string;
    positions: Position[];
}
interface LighterApiResponse {
    accounts: Account[];
}
// ---

export class LighterController {
    constructor(
        private readonly lighterService: LighterService,
        private readonly userState: Map<number, string>
    ) { }

    public async onAccountRequestPara(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Запрашиваю данные с Lighter.xyz...');

            // apiResponse теперь имеет тип LighterApiResponse
            const apiResponse = await this.lighterService.getAccountData();

            if (apiResponse && apiResponse.accounts && apiResponse.accounts.length > 0) {
                // account теперь имеет тип Account
                const account = apiResponse.accounts[0];
                const { positions, ...accountInfo } = account;

                console.log('✅ Основная информация по аккаунту Lighter:', accountInfo);

                // positions теперь имеет тип Position[]
                // Поэтому 'p' автоматически получает тип Position, и ошибка исчезает!
                const activePositions = positions.filter(p => p.position !== '0.00' && p.position !== '0.0');

                if (activePositions.length > 0) {
                    console.log('✅ Активные позиции:', activePositions);
                } else {
                    console.log('ℹ️ Активные позиции на аккаунте Lighter отсутствуют.');
                }

                await ctx.reply('✅ Запрос успешно выполнен! Данные выведены в лог сервера.', mainMenuKeyboard);

            } else {
                console.error('❌ API Lighter вернул некорректный ответ:', apiResponse);
                await ctx.reply('❌ API биржи вернул пустой или некорректный ответ.', mainMenuKeyboard);
            }

        } catch (error) {
            // ... обработка ошибок без изменений ...
            console.error('❌ Произошла ошибка в процессе запроса к Lighter:', error);
            await ctx.reply('❌ Произошла ошибка при выполнении запроса. Подробности в логе сервера.', mainMenuKeyboard);
        }
    }
}