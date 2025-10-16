import { Context } from "telegraf";
import { message } from "telegraf/filters";
import { Update } from "telegraf/typings/core/types/typegram";
import { TestService } from "./test.service";

// Импортируем наш псевдоним типа для клавиатуры, который мы создали ранее
type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class TestController {
    constructor(
        private calculatorService: TestService,
        private userState: Map<number, string>
    ) { }

    /**
     * Срабатывает, когда пользователь нажимает кнопку "Калькулятор".
     * Устанавливает состояние и просит ввести числа.
     */
    public onTestSum(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        const userId = ctx.from!.id;
        this.userState.set(userId, 'awaiting_sum_numbers');
        ctx.reply('Введите два числа через пробел (например, 7 8):', mainMenuKeyboard);
    }

    /**
     * Срабатывает, когда пользователь присылает числа для умножения.
     */
    public async onNumbersReceivedSum(ctx: Context<Update.MessageUpdate>, mainMenuKeyboard: ReplyKeyboard) {
        if (!ctx.has(message("text"))) return;

        const userId = ctx.from.id;
        const args = ctx.message.text.split(' ');

        if (args.length !== 2) {
            ctx.reply('Неверный формат. Нужно ввести ровно два числа через пробел.', mainMenuKeyboard);
            this.userState.delete(userId); // Сбрасываем состояние
            return;
        }

        const num1 = parseInt(args[0], 10);
        const num2 = parseInt(args[1], 10);

        if (isNaN(num1) || isNaN(num2)) {
            ctx.reply('Пожалуйста, введите корректные числа.', mainMenuKeyboard);
            this.userState.delete(userId); // Сбрасываем состояние
            return;
        }

        // Сбрасываем состояние, так как операция завершена
        this.userState.delete(userId);

        const result = this.calculatorService.sum(num1, num2);

        ctx.reply(`✅Результат: ${num1} + ${num2} = ${result}`, mainMenuKeyboard);
    }
}