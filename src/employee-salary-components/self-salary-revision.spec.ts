import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EmployeeSalaryComponentsController } from './employee-salary-components.controller';

function build() {
  const calls: string[] = [];
  const service = {
    setComponentValue: async () => {
      calls.push('set');
      return {};
    },
    bulkSetStructure: async () => {
      calls.push('bulk');
      return {};
    },
  };
  return {
    controller: new EmployeeSalaryComponentsController(
      service as never,
      {} as never,
    ),
    calls,
  };
}

const caller = (role: Role, id = 'u1') =>
  ({ id, role, organizationId: 'org' }) as never;

describe('who may revise whose salary', () => {
  it('an Admin may revise their own salary', async () => {
    const { controller, calls } = build();
    await controller.bulkSetStructure('u1', {} as never, caller(Role.ADMIN));
    await controller.setComponentValue('u1', {} as never, caller(Role.ADMIN));
    expect(calls).toEqual(['bulk', 'set']);
  });

  it('HR may not revise their own salary', () => {
    const { controller } = build();
    expect(() =>
      controller.bulkSetStructure('u1', {} as never, caller(Role.HR)),
    ).toThrow(ForbiddenException);
    expect(() =>
      controller.setComponentValue('u1', {} as never, caller(Role.HR)),
    ).toThrow(/An Admin must do it/);
  });

  it("HR and Admin may still revise someone else's salary", async () => {
    const { controller, calls } = build();
    await controller.bulkSetStructure('other', {} as never, caller(Role.HR));
    await controller.bulkSetStructure('other', {} as never, caller(Role.ADMIN));
    expect(calls).toEqual(['bulk', 'bulk']);
  });
});
