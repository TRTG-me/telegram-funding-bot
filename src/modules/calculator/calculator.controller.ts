// src/modules/calculator/calculator.controller.ts
import { Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { CalculatorService } from './calculator.service';

export class CalculatorController {
    // Создаем экземпляр сервиса
    private calculatorService = new CalculatorService();

    // Метод, который будет вызываться по команде /multiply
    public onMultiplyCommand = (ctx: Context) => {
        // Проверяем, что сообщение текстовое
        if (!ctx.has(message('text'))) {
            return;
        }

        // Разбираем сообщение: /multiply 5 10
        const args = ctx.message.text.split(' ').slice(1); // ['5', '10']

        if (args.length !== 2) {
            return ctx.reply('Неверный формат. Используйте: /multiply <число1> <число2>');
        }

        const num1 = parseInt(args[0], 10);
        const num2 = parseInt(args[1], 10);

        if (isNaN(num1) || isNaN(num2)) {
            return ctx.reply('Пожалуйста, введите два корректных числа.');
        }

        // Вызываем сервис для выполнения вычисления
        const result = this.calculatorService.multiply(num1, num2);

        // Отправляем ответ пользователю
        ctx.reply(`Результат умножения ${num1} на ${num2} равен: ${result}`);
    };
}