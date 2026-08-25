import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export enum ApplyTranslationMode {
  OVERWRITE_ACTIVE_VERSION = 'OVERWRITE_ACTIVE_VERSION',
  CREATE_ALTERNATE_VERSION = 'CREATE_ALTERNATE_VERSION',
}

export class ApplyTranslationJobDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(
    [
      ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION,
      ApplyTranslationMode.CREATE_ALTERNATE_VERSION,
    ],
    {
      message:
        'mode phải là OVERWRITE_ACTIVE_VERSION hoặc CREATE_ALTERNATE_VERSION',
    },
  )
  mode: ApplyTranslationMode;
}
