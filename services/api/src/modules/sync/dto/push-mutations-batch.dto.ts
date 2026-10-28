import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ClientMutationDto } from './client-mutation.dto';

export class PushMutationsBatchDto {
  /**
   * Batch of client mutations to push to the server.
   * Batch size is strictly bounded between 1 and 100 items.
   */
  @IsArray({ message: 'mutations must be an array' })
  @ArrayMinSize(1, { message: 'mutations array must contain at least 1 mutation' })
  @ArrayMaxSize(100, { message: 'mutations array cannot exceed 100 mutations' })
  @ValidateNested({ each: true })
  @Type(() => ClientMutationDto)
  mutations: ClientMutationDto[];
}
