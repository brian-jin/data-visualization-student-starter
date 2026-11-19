import type { ComponentType } from 'react';
import { ResponsivePseudoScatterPlot } from './week-01/ResponsivePseudoScatterPlot';
import { SummarizeDataset } from './week-02/SummarizeDataset';
import { FirstVisual } from './week-03/FirstVisual';
import { SecondPass } from './week-04/SecondPass';
import { NewInteraction } from './week-05/NewInteraction';
import { FirstVersion } from './week-06/FirstVersion';
import { SecondVersion } from './week-07/SecondVersion';
import { IterateProject } from './week-08/IterateProject';
import { Week10Interaction } from './week-10/Week10Interaction';
import { NextIteration } from './week-11/NextIteration';
import { VizHub } from './week-12/VizHub';
import { Week13 } from './week-13/Week13';

export interface Assignment {
  id: string;
  name: string;
  component: ComponentType;
}

export const assignments: Assignment[] = [
  {
    id: '1',
    name: 'Week 1',
    component: ResponsivePseudoScatterPlot,
  },
  {
    id: '2',
    name: 'Week 2',
    component: SummarizeDataset,
  },
  {
    id: '3',
    name: 'Week 3',
    component: FirstVisual,
  },
  {
    id: '4',
    name: 'Week 4',
    component: SecondPass,
  },
  {
    id: '5',
    name: 'Week 5',
    component: NewInteraction,
  },
  {
    id: '6',
    name: 'Week 6',
    component: FirstVersion,
  },
  {
    id: '7',
    name: 'Week 7',
    component: SecondVersion,
  },
  {
    id: '8',
    name: 'Week 8',
    component: IterateProject,
  },
  {
    id: '9',
    name: 'Week 10',
    component: Week10Interaction,
  },
  {
    id: '11',
    name: 'Week 11',
    component: NextIteration,
  },
  {
    id: '12',
    name: 'Week 12',
    component: VizHub,
  },
  {
    id: '13',
    name: 'Week 13',
    component: Week13,
  },
];

export const assignmentsMap = new Map(assignments.map((ex) => [ex.id, ex]));

export const defaultAssignment = '2';
