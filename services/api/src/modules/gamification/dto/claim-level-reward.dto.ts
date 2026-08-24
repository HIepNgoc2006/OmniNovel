import { IsInt, Min } from 'class-validator';

export class ClaimLevelRewardDto {
  @IsInt({ message: 'Milestone level phải là số nguyên' })
  @Min(1, { message: 'Milestone level tối thiểu là 1' })
  milestoneLevel: number;
}
