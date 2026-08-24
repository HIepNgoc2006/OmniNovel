import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedLevelRewards1700000000002 implements MigrationInterface {
  name = 'SeedLevelRewards1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO level_rewards (milestone_level, reward_coins, reward_badge_id) VALUES
      (2, 20, 'BADGE_LVL_2'),
      (5, 50, 'BADGE_LVL_5'),
      (10, 100, 'BADGE_LVL_10'),
      (20, 200, 'BADGE_LVL_20'),
      (30, 300, 'BADGE_LVL_30'),
      (50, 500, 'BADGE_LVL_50'),
      (100, 1000, 'BADGE_LVL_100')
      ON CONFLICT (milestone_level) DO UPDATE SET
        reward_coins = EXCLUDED.reward_coins,
        reward_badge_id = EXCLUDED.reward_badge_id;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM level_rewards WHERE milestone_level IN (2, 5, 10, 20, 30, 50, 100);
    `);
  }
}
