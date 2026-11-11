import { IsOptional, validate } from 'class-validator';
import { IsTimeOfDay, NoMarkup } from './decorators/no-markup.decorator';

class Sample {
  @IsOptional() @NoMarkup('Name') name?: string;
  @IsOptional() @IsTimeOfDay('Start time') start?: string;
}
const check = async (v: Partial<Sample>) => validate(Object.assign(new Sample(), v));

describe('NoMarkup', () => {
  it.each(['<script>alert(1)</script>', 'a < b', 'x>y', 'bad\u0007name'])('refuses %j', async (name) => {
    expect((await check({ name })).length).toBe(1);
  });
  it.each(['R&D / Ops (QA)', "O'Brien & Sons, Pvt. Ltd.", 'Sales #2 - North', 'अनुसंधान'])('allows %j', async (name) => {
    expect(await check({ name })).toHaveLength(0);
  });
});

describe('IsTimeOfDay', () => {
  it.each(['25:99', 'abc', '9:30', '24:00', '12:60'])('refuses %j', async (start) => {
    expect((await check({ start })).length).toBe(1);
  });
  it.each(['00:00', '09:30', '23:59'])('allows %j', async (start) => {
    expect(await check({ start })).toHaveLength(0);
  });
});
