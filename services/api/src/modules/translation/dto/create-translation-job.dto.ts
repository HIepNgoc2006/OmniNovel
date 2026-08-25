import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
} from 'class-validator';

export class CreateTranslationJobDto {
  @IsUUID(undefined, { message: 'chapterVersionId phải là UUID hợp lệ' })
  @IsNotEmpty({ message: 'chapterVersionId không được để trống' })
  chapterVersionId: string;

  @IsString()
  @IsNotEmpty()
  sourceLang: string;

  @IsString()
  @IsNotEmpty()
  targetLang: string;

  @IsOptional()
  @IsString()
  @IsIn(
    [
      'MOCK',
      'LOCAL',
      'LOCAL_LLM',
      'OPENAI',
      'DEEPL',
      'GEMINI',
      'CLAUDE',
    ],
    {
      message:
        'Provider phải thuộc danh sách hợp lệ (MOCK, LOCAL, LOCAL_LLM, OPENAI, DEEPL, GEMINI, CLAUDE)',
    },
  )
  provider?: string;

  @IsOptional()
  @IsBoolean({ message: 'externalConsent phải là kiểu boolean (true/false)' })
  externalConsent?: boolean;
}
