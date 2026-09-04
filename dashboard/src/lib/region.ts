/**
 * The platform runs US-only, on UTC.
 *
 * Both are policy, not preference, so they are constants here rather than fields an operator
 * fills in per person. Two consequences worth knowing:
 *
 * - Every timestamp in this console is rendered in UTC and says so. The daily application
 *   cap resets on `UTC_DATE()` server-side, so showing an operator a local-time clock would
 *   make "how many are left today" disagree with what the API enforces.
 * - Country is fixed to US, which is also what proxy auto-assignment matches on. A job
 *   seeker created with any other country would be provisioned without a proxy.
 */

export const COUNTRY = 'US';
export const COUNTRY_LABEL = 'United States';
export const TIMEZONE = 'UTC';

/** States and territories, for the intake dropdown. */
export const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

/** Common starting points for a location filter. "Remote" is not a place but reads as one. */
export const COMMON_LOCATIONS = [
  'Remote',
  'New York, NY',
  'San Francisco, CA',
  'Seattle, WA',
  'Austin, TX',
  'Boston, MA',
  'Chicago, IL',
  'Denver, CO',
  'Atlanta, GA',
  'Los Angeles, CA',
];

/**
 * Suggestion lists for the intake combo-boxes.
 *
 * These are starting points, not closed sets — every field they back also accepts free text.
 * A dropdown that cannot express a real answer produces a wrong record, not a tidy one, so
 * none of these is enforced.
 */
export const US_CITIES = [
  'Remote',
  'Atlanta, GA', 'Austin, TX', 'Baltimore, MD', 'Boston, MA', 'Charlotte, NC',
  'Chicago, IL', 'Cincinnati, OH', 'Cleveland, OH', 'Columbus, OH', 'Dallas, TX',
  'Denver, CO', 'Detroit, MI', 'Houston, TX', 'Indianapolis, IN', 'Jacksonville, FL',
  'Kansas City, MO', 'Las Vegas, NV', 'Los Angeles, CA', 'Miami, FL', 'Milwaukee, WI',
  'Minneapolis, MN', 'Nashville, TN', 'New York, NY', 'Orlando, FL', 'Philadelphia, PA',
  'Phoenix, AZ', 'Pittsburgh, PA', 'Portland, OR', 'Raleigh, NC', 'Sacramento, CA',
  'Salt Lake City, UT', 'San Antonio, TX', 'San Diego, CA', 'San Francisco, CA',
  'San Jose, CA', 'Seattle, WA', 'St. Louis, MO', 'Tampa, FL', 'Washington, DC',
];

export const COMMON_ROLES = [
  'Backend Engineer', 'Senior Backend Engineer', 'Staff Backend Engineer',
  'Frontend Engineer', 'Senior Frontend Engineer',
  'Full Stack Engineer', 'Senior Full Stack Engineer',
  'Software Engineer', 'Senior Software Engineer', 'Staff Software Engineer',
  'Platform Engineer', 'Site Reliability Engineer', 'DevOps Engineer',
  'Cloud Engineer', 'Infrastructure Engineer',
  'Data Engineer', 'Senior Data Engineer', 'Analytics Engineer',
  'Data Scientist', 'Machine Learning Engineer',
  'Mobile Engineer', 'iOS Engineer', 'Android Engineer',
  'QA Engineer', 'Automation Engineer',
  'Security Engineer', 'Solutions Architect', 'Engineering Manager',
  'Product Manager', 'Technical Program Manager', 'Business Analyst',
];

export const COMMON_SKILLS = [
  'JavaScript', 'TypeScript', 'Node.js', 'React', 'Next.js', 'Angular', 'Vue',
  'Python', 'Django', 'FastAPI', 'Java', 'Spring Boot', 'Go', 'Rust', 'C#', '.NET',
  'Ruby', 'Rails', 'PHP', 'Laravel',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'GitHub Actions',
  'REST', 'GraphQL', 'gRPC', 'Kafka', 'RabbitMQ',
  'CI/CD', 'Microservices', 'Distributed Systems', 'System Design',
  'Spark', 'Airflow', 'dbt', 'Snowflake', 'Tableau', 'Power BI',
  'Playwright', 'Cypress', 'Selenium', 'Jest',
];
