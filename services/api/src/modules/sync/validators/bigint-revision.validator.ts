import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const MAX_POSTGRES_BIGINT = 9223372036854775807n;

export interface BigIntRevisionOptions {
  min?: bigint;
  max?: bigint;
}

@ValidatorConstraint({ name: 'IsValidBigIntRevision', async: false })
export class IsValidBigIntRevisionConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    // Must be strictly unsigned digits with no leading/trailing whitespace
    if (!/^\d+$/.test(value)) {
      return false;
    }

    try {
      const bigIntVal = BigInt(value);
      const options = (args.constraints?.[0] as BigIntRevisionOptions) || {};
      const min = options.min ?? 0n;
      const max = options.max ?? MAX_POSTGRES_BIGINT;

      return bigIntVal >= min && bigIntVal <= max;
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    const options = (args.constraints?.[0] as BigIntRevisionOptions) || {};
    const min = options.min ?? 0n;
    const max = options.max ?? MAX_POSTGRES_BIGINT;
    return `${args.property} must be an unsigned decimal string representing an integer between ${min} and ${max}`;
  }
}

export function IsValidBigIntRevision(
  options?: BigIntRevisionOptions,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [options],
      validator: IsValidBigIntRevisionConstraint,
    });
  };
}
