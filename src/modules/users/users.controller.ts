import { Context } from "telegraf";
import { UserService } from "./users.service";

/**
 * UsersController
 * 
 * ВАЖНО: Логика добавления пользователей перенесена в отдельный скрипт:
 * scripts/upload-user-data.ts
 * 
 * Для добавления/обновления пользователей используйте:
 * npx ts-node scripts/upload-user-data.ts
 * 
 * Подробная инструкция: scripts/README.md
 */

export class UsersController {
    constructor(private userService: UserService) { }

    // Контроллер больше не используется для загрузки данных
    // Оставлен для совместимости, если будут другие методы
}
