import { LOCAL_STORAGE_KEYS } from "@/lib/constants";
import { useUserPreferences } from "@/lib/hooks";
import LoadingPage from "@/lib/layouts/LoadingPage";
import LoggedIn from "@/lib/layouts/LoggedIn";
import { gqlClient } from "@/lib/services/api";
import {
	ActionIcon,
	Box,
	Button,
	Collapse,
	Container,
	Drawer,
	Flex,
	MultiSelect,
	NumberInput,
	Paper,
	ScrollArea,
	Select,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Textarea,
	Title,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { useDisclosure, useLocalStorage } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	CreateUserMeasurementDocument,
	type CreateUserMeasurementMutationVariables,
	DeleteUserMeasurementDocument,
	type DeleteUserMeasurementMutationVariables,
	type UserMeasurement,
	UserMeasurementsListDocument,
} from "@ryot/generated/graphql/backend/graphql";
import { changeCase, snakeCase, startCase } from "@ryot/ts-utils";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { get, set } from "lodash";
import { DateTime } from "luxon";
import Head from "next/head";
import { type ReactElement } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { match } from "ts-pattern";
import type { NextPageWithLayout } from "../_app";

const getValues = (m: UserMeasurement["stats"]) => {
	const vals: { name: string; value: string }[] = [];
	for (const [key, val] of Object.entries(m)) {
		if (key !== "custom") {
			if (val !== null) {
				vals.push({ name: key, value: val });
			}
		} else {
			for (const [keyC, valC] of Object.entries(m.custom || {})) {
				// biome-ignore lint/suspicious/noExplicitAny: required
				vals.push({ name: keyC, value: valC as any });
			}
		}
	}
	return vals;
};

const DisplayMeasurement = (props: {
	measurement: UserMeasurement;
	refetch: () => void;
}) => {
	const [opened, { toggle }] = useDisclosure(false);
	const values = getValues(props.measurement.stats);
	const deleteUserMeasurement = useMutation({
		mutationFn: async (variables: DeleteUserMeasurementMutationVariables) => {
			const { deleteUserMeasurement } = await gqlClient.request(
				DeleteUserMeasurementDocument,
				variables,
			);
			return deleteUserMeasurement;
		},
		onSuccess: () => {
			props.refetch();
		},
	});

	return (
		<Paper key={props.measurement.timestamp.toISOString()} withBorder p="xs">
			<Flex direction="column" justify="center" gap="xs">
				<Flex justify="space-around">
					<Button onClick={toggle} variant="default" size="compact-xs">
						{DateTime.fromJSDate(props.measurement.timestamp).toLocaleString(
							DateTime.DATETIME_SHORT,
						)}
					</Button>
					<ActionIcon
						color="red"
						size="sm"
						onClick={() => {
							const yes = confirm(
								"This action can not be undone. Are you sure you want to delete this measurement?",
							);
							if (yes)
								deleteUserMeasurement.mutate({
									timestamp: props.measurement.timestamp,
								});
						}}
					>
						<IconTrash size={16} />
					</ActionIcon>
				</Flex>
				<Collapse in={opened}>
					{props.measurement.name ? (
						<Text ta="center">Name: {props.measurement.name}</Text>
					) : undefined}
					{props.measurement.comment ? (
						<Text ta="center">Comment: {props.measurement.comment}</Text>
					) : undefined}
					{values.map((v) => (
						<Text key={v.name} ta="center">
							{startCase(snakeCase(v.name))}: {v.value}
						</Text>
					))}
				</Collapse>
			</Flex>
		</Paper>
	);
};

const dateFormatter = (date: Date) => {
	return DateTime.fromJSDate(date).toLocaleString(DateTime.DATETIME_SHORT);
};

enum TimeSpan {
	Last7Days = "Last 7 days",
	Last30Days = "Last 30 days",
	Last90Days = "Last 90 days",
	Last365Days = "Last 365 days",
	AllTime = "All Time",
}

const Page: NextPageWithLayout = () => {
	const [selectedStats, setselectedStats] = useLocalStorage<string[]>({
		defaultValue: [],
		key: LOCAL_STORAGE_KEYS.savedMeasurementsDisplaySelectedStats,
		getInitialValueInEffect: true,
	});
	const [selectedTimeSpan, setselectedTimespan] = useLocalStorage({
		defaultValue: TimeSpan.Last30Days,
		key: LOCAL_STORAGE_KEYS.savedMeasurementsDisplaySelectedTimespan,
		getInitialValueInEffect: true,
	});
	const [opened, { open, close }] = useDisclosure(false);

	const preferences = useUserPreferences();
	const userMeasurementsList = useQuery({
		queryKey: ["userMeasurementsList", selectedTimeSpan],
		queryFn: async () => {
			const now = DateTime.now();
			const [startTime, endTime] = match(selectedTimeSpan)
				.with(TimeSpan.Last7Days, () => [now, now.minus({ days: 7 })])
				.with(TimeSpan.Last30Days, () => [now, now.minus({ days: 30 })])
				.with(TimeSpan.Last90Days, () => [now, now.minus({ days: 90 })])
				.with(TimeSpan.Last365Days, () => [now, now.minus({ days: 365 })])
				.with(TimeSpan.AllTime, undefined, () => [null, null])
				.exhaustive();
			const { userMeasurementsList } = await gqlClient.request(
				UserMeasurementsListDocument,
				{
					input: {
						startTime: startTime?.toJSDate(),
						endTime: endTime?.toJSDate(),
					},
				},
			);
			return userMeasurementsList;
		},
	});
	const createUserMeasurement = useMutation({
		mutationFn: async (variables: CreateUserMeasurementMutationVariables) => {
			const { createUserMeasurement } = await gqlClient.request(
				CreateUserMeasurementDocument,
				variables,
			);
			return createUserMeasurement;
		},
		onSuccess: () => {
			userMeasurementsList.refetch();
			notifications.show({
				title: "Success",
				message: "Added new measurement",
				color: "green",
			});
			close();
		},
	});

	return userMeasurementsList.data && preferences.data ? (
		<>
			<Head>
				<title>Measurements | Ryot</title>
			</Head>
			<Container>
				<Drawer opened={opened} onClose={close} title="Add new measurement">
					<Box
						component="form"
						onSubmit={(e) => {
							e.preventDefault();
							const submitData = {};
							const formData = new FormData(e.currentTarget);
							for (const [name, value] of formData.entries())
								if (value !== "") set(submitData, name, value);
							if (Object.keys(submitData).length > 0) {
								createUserMeasurement.mutate({
									// biome-ignore lint/suspicious/noExplicitAny: required
									input: submitData as any,
								});
							}
						}}
					>
						<Stack>
							<DateTimePicker
								label="Timestamp"
								defaultValue={new Date()}
								name="timestamp"
								required
							/>
							<TextInput label="Name" name="name" />
							<SimpleGrid cols={2} style={{ alignItems: "end" }}>
								{Object.keys(preferences.data.fitness.measurements.inbuilt)
									.filter((n) => n !== "custom")
									.filter(
										(n) =>
											// biome-ignore lint/suspicious/noExplicitAny: required
											(preferences as any).data.fitness.measurements.inbuilt[n],
									)
									.map((v) => (
										<NumberInput
											decimalScale={3}
											key={v}
											label={changeCase(snakeCase(v))}
											name={`stats.${v}`}
										/>
									))}
								{preferences.data.fitness.measurements.custom.map(
									({ name }) => (
										<NumberInput
											key={name}
											label={changeCase(snakeCase(name))}
											name={`stats.custom.${name}`}
										/>
									),
								)}
							</SimpleGrid>
							<Textarea label="Comment" name="comment" />
							<Button type="submit">Submit</Button>
						</Stack>
					</Box>
				</Drawer>
				<Stack>
					<Flex align="center" gap="md">
						<Title>Measurements</Title>
						<ActionIcon color="green" variant="outline" onClick={open}>
							<IconPlus size={20} />
						</ActionIcon>
					</Flex>
					<SimpleGrid cols={{ base: 1, md: 2 }}>
						<MultiSelect
							label="Statistics to display"
							data={[
								...Object.keys(preferences.data.fitness.measurements.inbuilt)
									.filter(
										(n) =>
											// biome-ignore lint/suspicious/noExplicitAny: required
											(preferences as any).data.fitness.measurements.inbuilt[n],
									)
									.map((v) => ({ name: v, value: v })),
								...preferences.data.fitness.measurements.custom.map(
									({ name }) => ({ name, value: `custom.${name}` }),
								),
							].map((v) => ({
								value: v.value,
								label: startCase(v.name),
							}))}
							value={selectedStats}
							onChange={(s) => {
								if (s) setselectedStats(s);
							}}
						/>
						<Select
							label="Timespan"
							value={selectedTimeSpan}
							data={Object.values(TimeSpan)}
							onChange={(v) => {
								if (v) setselectedTimespan(v as TimeSpan);
							}}
						/>
					</SimpleGrid>
					<Box w="100%" ml={-15}>
						{selectedStats ? (
							<ResponsiveContainer width="100%" height={300}>
								<LineChart
									data={userMeasurementsList.data}
									margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
								>
									<CartesianGrid strokeDasharray="3 3" />
									<XAxis
										dataKey="timestamp"
										tickFormatter={dateFormatter}
										hide
									/>
									<YAxis domain={["dataMin - 1", "dataMax + 1"]} />
									<Tooltip />
									{selectedStats.map((s) => (
										<Line
											key={s}
											type="monotone"
											dot={false}
											dataKey={(v) => {
												const data = get(v.stats, s);
												if (data) return Number(data);
												return null;
											}}
											name={s}
											connectNulls
										/>
									))}
								</LineChart>
							</ResponsiveContainer>
						) : undefined}
					</Box>
					{userMeasurementsList.data.length > 0 ? (
						<ScrollArea h={400}>
							<SimpleGrid cols={{ base: 2, md: 3, xl: 4 }}>
								{userMeasurementsList.data.map((m) => (
									<DisplayMeasurement
										key={m.timestamp.toISOString()}
										measurement={m}
										refetch={userMeasurementsList.refetch}
									/>
								))}
							</SimpleGrid>
						</ScrollArea>
					) : (
						<Text ta="center">
							You have not added any measurements in this time period.
						</Text>
					)}
				</Stack>
			</Container>
		</>
	) : (
		<LoadingPage />
	);
};

Page.getLayout = (page: ReactElement) => {
	return <LoggedIn>{page}</LoggedIn>;
};

export default Page;
