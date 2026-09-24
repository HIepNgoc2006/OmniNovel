import { BadRequestException, HttpException, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockArgumentsHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockRequest = {
      headers: {
        'x-request-id': 'req-test-1234',
      },
    };
    mockArgumentsHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('phải trích xuất đúng code và message khi ném structured BadRequestException object (CHECKIN_REQUEST_IN_FLIGHT)', () => {
    const exception = new BadRequestException({
      code: 'CHECKIN_REQUEST_IN_FLIGHT',
      message: 'CHECKIN_REQUEST_IN_FLIGHT: Yêu cầu điểm danh đang được xử lý.',
    });

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'CHECKIN_REQUEST_IN_FLIGHT',
          message: 'CHECKIN_REQUEST_IN_FLIGHT: Yêu cầu điểm danh đang được xử lý.',
          requestId: 'req-test-1234',
        }),
      }),
    );
  });

  it('phải trích xuất đúng code và message khi ném LEVEL_REWARD_REQUEST_IN_FLIGHT', () => {
    const exception = new BadRequestException({
      code: 'LEVEL_REWARD_REQUEST_IN_FLIGHT',
      message: 'LEVEL_REWARD_REQUEST_IN_FLIGHT: Yêu cầu nhận thưởng cấp độ đang được xử lý.',
    });

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'LEVEL_REWARD_REQUEST_IN_FLIGHT',
          message: 'LEVEL_REWARD_REQUEST_IN_FLIGHT: Yêu cầu nhận thưởng cấp độ đang được xử lý.',
          requestId: 'req-test-1234',
        }),
      }),
    );
  });

  it('phải fallback về getStatusCodeName khi ném chuỗi thông thường không có code object', () => {
    const exception = new BadRequestException('Chuỗi thông báo lỗi đơn thuần');

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Chuỗi thông báo lỗi đơn thuần',
          requestId: 'req-test-1234',
        }),
      }),
    );
  });

  it('phải trích xuất retryAfter vào error.meta khi ném HttpException TOO_MANY_REQUESTS', () => {
    const exception = new HttpException(
      {
        code: 'TOO_MANY_REQUESTS',
        message: 'Bạn đã vượt quá giới hạn tần suất yêu cầu.',
        retryAfter: 45,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'TOO_MANY_REQUESTS',
          message: 'Bạn đã vượt quá giới hạn tần suất yêu cầu.',
          requestId: 'req-test-1234',
          meta: expect.objectContaining({
            retryAfter: 45,
          }),
        }),
      }),
    );
  });
});
