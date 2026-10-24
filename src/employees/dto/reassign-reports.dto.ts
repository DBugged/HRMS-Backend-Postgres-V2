import { IsString, IsNotEmpty } from 'class-validator';

/** Body of POST /employees/:id/reassign-reports - the manager who takes over everyone reporting to :id. */
export class ReassignReportsDto {
  @IsString()
  @IsNotEmpty()
  newManagerId!: string;
}
