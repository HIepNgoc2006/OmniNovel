import { IsUUID, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class CreateGlossaryDto {
  @IsUUID()
  @IsNotEmpty()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  sourceTerm: string;

  @IsString()
  @IsNotEmpty()
  targetTerm: string;

  @IsOptional()
  @IsString()
  category?: string;
}
